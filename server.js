import express from 'express';         // Express for creating the server
import fetch from 'node-fetch';        // Fetch API to make HTTP requests
import dotenv from 'dotenv';          // For loading environment variables from .env file
import path from 'path';              // Path module for working with file and directory paths

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(express.static(path.join(process.cwd(), 'public'))); 
app.use(express.json());  

// Helper function to parse Steam profile URL and return Steam ID or Vanity URL
function parseProfileUrl(url) {
  // Match Steam profile URLs like '/profiles/XXXXXXXXXXXXXXX' (SteamID64)
  const byId = url.match(/\/profiles\/(\d{17})/);
  // Match Vanity URLs like '/id/username'
  const byVanity = url.match(/\/id\/([^\/]+)/);
  if (byId) return { type: 'profiles', id: byId[1] };
  if (byVanity) return { type: 'id', id: byVanity[1] };
  return null; // Return null if neither is matched
}

// Read the Steam API key 
const STEAM_KEY = process.env.STEAM_API_KEY;

// Endpoint to get profile information based on the profile URL
app.post('/get-profile', async (req, res) => {
  const parsed = parseProfileUrl(req.body.profileUrl || '');
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid Steam profile URL.' });
  }

  try {
    // Resolve Vanity URL to SteamID64 if necessary
    const sumUrl = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
    sumUrl.searchParams.set('key', STEAM_KEY);
    if (parsed.type === 'profiles') sumUrl.searchParams.set('steamids', parsed.id); // If SteamID64, use steamids
    else sumUrl.searchParams.set('vanityurl', parsed.id); // If Vanity URL, use vanityurl
    const sumJson = await (await fetch(sumUrl)).json();
    const player = sumJson.response.players[0]; 
    if (!player) throw new Error('User not found or profile is private.');
    const steamid = player.steamid; 

    // Try fetching the profile background
    let backgroundUrl = null, isVideo = false;
    const bgRes = await fetch(
      `https://api.steampowered.com/IPlayerService/GetProfileBackground/v1/?key=${STEAM_KEY}&steamid=${steamid}`
    );
    const bgJson = await bgRes.json();
    backgroundUrl = bgJson.response?.background_url || null; // Get background URL from response

    // Fallback to scraping if no background URL was found
    if (!backgroundUrl) {
      const profilePage = parsed.type === 'profiles'
        ? `https://steamcommunity.com/profiles/${parsed.id}`
        : `https://steamcommunity.com/id/${parsed.id}`;
      const html = await (await fetch(profilePage)).text();

      // Try extracting background image from CSS
      const mImg = html.match(/background-image:\s*url\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (mImg) {
        backgroundUrl = mImg[1]; 
      }

      // Try extracting background video URL from <video> or <source> tags
      if (!backgroundUrl) {
        const mVid = html.match(/<video[^>]*\ssrc=["']([^"']+)["']/i)
                       || html.match(/<source[^>]*\ssrc=["']([^"']+)["']/i);
        if (mVid) {
          backgroundUrl = mVid[1]; 
          isVideo = true; // Flag as video background
        }
      }
    }

    // Fetch the friend count
    const friendsRes = await fetch(
      `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/`
      + `?key=${STEAM_KEY}&steamid=${steamid}&relationship=friend`
    );
    const friendsJson = await friendsRes.json();
    const friendCount = friendsJson.friendslist?.friends?.length || 0; 

    // Fetch top 5 played games + achievements + stats
    const gamesRes = await fetch(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/`
      + `?key=${STEAM_KEY}&steamid=${steamid}&include_appinfo=true`
    );
    const gamesJson = await gamesRes.json();
    const topGamesRaw = (gamesJson.response.games || [])
      .sort((a, b) => b.playtime_forever - a.playtime_forever) // Sort games by playtime (descending)
      .slice(0, 5); // Get top 5 games

    // Fetch achievements and stats for each game
    const topGames = await Promise.all(topGamesRaw.map(async g => {
      let totalAchievements = 0, achieved = 0;
      try {
        const achRes = await fetch(
          `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/`
          + `?key=${STEAM_KEY}&steamid=${steamid}&appid=${g.appid}`
        );
        const achJson = await achRes.json();
        const arr = achJson.playerstats?.achievements || [];
        totalAchievements = arr.length;
        achieved = arr.filter(a => a.achieved === 1).length; // Count achieved achievements
      } catch {}

      let stats = [];
      try {
        const stRes = await fetch(
          `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v0002/`
          + `?key=${STEAM_KEY}&steamid=${steamid}&appid=${g.appid}`
        );
        const stJson = await stRes.json();
        stats = stJson.playerstats?.stats || []; // Fetch game stats
      } catch {}

      return {
        appid: g.appid,
        name: g.name,
        img_icon_url: g.img_icon_url,
        playtime_hours: Math.round(g.playtime_forever / 60), // Convert playtime from minutes to hours
        totalAchievements,
        achieved,
        stats
      };
    }));

    // Fetch Steam level
    const lvlRes = await fetch(
      `https://api.steampowered.com/IPlayerService/GetBadges/v1/`
      + `?key=${STEAM_KEY}&steamid=${steamid}`
    );
    const steamLevel = (await (await lvlRes).json()).response.player_level; 

    // Return all fetched data as a JSON
    res.json({ player, backgroundUrl, isVideo, friendCount, topGames, steamLevel });
  }
  catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Steam API error' });
  }
});

app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
