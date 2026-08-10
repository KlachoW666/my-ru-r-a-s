const https = require('https');
const fs = require('fs');
const path = require('path');

const STEAM_API_KEY = 'F08021AF0F2223EBD08820781CBC2B2D';
const RUST_APP_ID = 252490;
const DATA_DIR = path.resolve(__dirname, '../data');
const SKINS_FILE = path.join(DATA_DIR, 'skins.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Map Steam name_color hex codes to Rarity names
function getRarityFromColor(colorHex) {
  if (!colorHex) return 'uncommon';
  const c = colorHex.toLowerCase();
  if (c.includes('d32ce6') || c.includes('eb4b4b') || c.includes('e4ae39')) return 'mythic';
  if (c.includes('8847ff') || c.includes('b0c3d9')) return 'legendary';
  if (c.includes('4b69ff') || c.includes('35a3f1')) return 'rare';
  if (c.includes('5e98d9')) return 'uncommon';
  return 'common';
}

// Fetch helper with headers
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON response from ${url}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Sync Rust Skins from Steam Community Market API
 */
async function syncRustSkins(count = 100) {
  console.log(`[SteamSync] Starting Steam Rust skins sync (Count: ${count})...`);
  const url = `https://steamcommunity.com/market/search/render/?query=&start=0&count=${count}&search_descriptions=0&sort_column=default&sort_dir=desc&appid=${RUST_APP_ID}&norender=1&currency=5`;
  
  try {
    const response = await fetchUrl(url);
    if (!response || !response.success || !response.results) {
      throw new Error('Invalid response received from Steam Community Market API');
    }

    const skins = response.results.map((item, index) => {
      const desc = item.asset_description || {};
      const iconUrl = desc.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}`
        : '/assets/header/logo.webp';
      
      // Calculate price in RUB
      const rawPrice = item.sell_price ? item.sell_price / 100 : 100;
      const priceRub = Math.round(rawPrice * 90); // Convert USD/Cents to RUB if needed or use sell_price

      return {
        id: `steam-${desc.classid || index}`,
        name: item.name || desc.market_hash_name || `Rust Skin #${index + 1}`,
        marketHashName: item.hash_name || desc.market_hash_name,
        price: priceRub > 0 ? priceRub : 150,
        priceText: `${priceRub > 0 ? priceRub : 150} ₽`,
        image: iconUrl,
        rarity: getRarityFromColor(desc.name_color),
        colorHex: `#${desc.name_color || 'b0c3d9'}`,
        tradable: desc.tradable === 1,
        listingsCount: item.sell_listings || 0
      };
    });

    const payload = {
      updatedAt: new Date().toISOString(),
      totalCount: response.total_count || skins.length,
      count: skins.length,
      skins: skins
    };

    fs.writeFileSync(SKINS_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[SteamSync] Successfully synced ${skins.length} Rust skins to ${SKINS_FILE}!`);
    return payload;

  } catch (error) {
    console.error('[SteamSync] Error syncing Steam Rust skins:', error.message);
    // If cached file exists, return cached payload
    if (fs.existsSync(SKINS_FILE)) {
      console.log('[SteamSync] Returning cached skins payload.');
      return JSON.parse(fs.readFileSync(SKINS_FILE, 'utf8'));
    }
    throw error;
  }
}

/**
 * Fetch player profile summary via Steam Web API using API Key
 */
async function getSteamPlayerSummary(steamId) {
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
  try {
    const res = await fetchUrl(url);
    if (res?.response?.players && res.response.players.length > 0) {
      return res.response.players[0];
    }
    return null;
  } catch (e) {
    console.error('[SteamSync] Error fetching player summary:', e.message);
    return null;
  }
}

module.exports = {
  syncRustSkins,
  getSteamPlayerSummary,
  STEAM_API_KEY,
  SKINS_FILE
};

// If run directly from CLI
if (require.main === module) {
  syncRustSkins(50)
    .then(res => console.log(`Synced ${res.skins.length} skins successfully.`))
    .catch(err => console.error('Sync failed:', err));
}
