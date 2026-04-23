const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

// ─── Manifest ────────────────────────────────────────────────────────────────

const manifest = {
  id: 'community.vidsrc.addon',
  version: '2.0.0',
  name: 'VidSrc',
  description: 'Watch movies & TV series via VidSrc. Streams play inside Stremio.',
  logo: 'https://vidsrc.to/favicon-32x32.png',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE = 'https://vidsrc.xyz/embed';
const TIMEOUT = 10000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, ms = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Fetch embed page HTML
async function fetchEmbed(url) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Referer': 'https://vidsrc.xyz/',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Parse the embed page and follow src chain to get the final iframe URL
async function resolveEmbedChain(embedUrl) {
  const html = await fetchEmbed(embedUrl);
  const $ = cheerio.load(html);

  // vidsrc.xyz puts the real player in an iframe
  let iframeSrc = $('iframe#player_iframe').attr('src')
    || $('iframe').first().attr('src');

  if (!iframeSrc) throw new Error('No iframe found in embed page');

  // Make absolute if relative
  if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;
  if (iframeSrc.startsWith('/')) iframeSrc = 'https://vidsrc.xyz' + iframeSrc;

  return iframeSrc;
}

// Extract m3u8 URL from the player page
async function extractM3U8(playerUrl) {
  const res = await fetchWithTimeout(playerUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Referer': 'https://vidsrc.xyz/',
    }
  });
  if (!res.ok) throw new Error(`Player page HTTP ${res.status}`);
  const html = await res.text();

  // Look for m3u8 URL in the page source
  const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
  if (m3u8Match) return m3u8Match[0];

  // Some players encode it in a JSON config
  const sourceMatch = html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
  if (sourceMatch) return sourceMatch[1];

  // Try src= pattern
  const srcMatch = html.match(/src\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/);
  if (srcMatch) return srcMatch[1];

  throw new Error('Could not find m3u8 URL in player page');
}

// Main stream extractor
async function getStreams(type, imdbId, season, episode) {
  const embedUrl = type === 'movie'
    ? `${BASE}/movie/${imdbId}`
    : `${BASE}/tv/${imdbId}/${season}-${episode}`;

  console.log(`[vidsrc] Fetching: ${embedUrl}`);

  const playerUrl = await resolveEmbedChain(embedUrl);
  console.log(`[vidsrc] Player URL: ${playerUrl}`);

  const m3u8Url = await extractM3U8(playerUrl);
  console.log(`[vidsrc] m3u8: ${m3u8Url}`);

  return m3u8Url;
}

// ─── Addon ────────────────────────────────────────────────────────────────────

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream] type=${type} id=${id}`);

  let imdbId, season, episode;

  if (type === 'movie') {
    imdbId = id;
  } else if (type === 'series') {
    [imdbId, season, episode] = id.split(':');
    season = parseInt(season, 10);
    episode = parseInt(episode, 10);
    if (!imdbId || isNaN(season) || isNaN(episode)) {
      console.warn('[stream] Malformed series ID:', id);
      return { streams: [] };
    }
  } else {
    return { streams: [] };
  }

  try {
    const m3u8Url = await getStreams(type, imdbId, season, episode);

    return {
      streams: [{
        name: 'VidSrc',
        title: type === 'series' ? `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : 'Watch',
        url: m3u8Url,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: 'vidsrc',
        },
      }]
    };
  } catch (err) {
    console.error(`[stream] Failed for ${id}:`, err.message);
    return { streams: [] };
  }
});

const express = require('express');
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});
const addonInterface = builder.getInterface();

app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/:resource/:type/:id.json', (req, res) => {
  const { resource, type, id } = req.params;
  addonInterface.get({ resource, type, id })
    .then(resp => res.json(resp))
    .catch(err => res.status(500).json({ error: err.message }));
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => console.log(`Addon running on port ${PORT}`));