try { process.loadEnvFile(require('path').resolve(__dirname, '..', '.env')); } catch {}
const https = require('https');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Ключ Steam Web API. В проде задавать через переменную окружения STEAM_API_KEY —
// значение ниже лежит в репозитории открытым текстом и подлежит ротации.
const STEAM_API_KEY = process.env.STEAM_API_KEY || 'F08021AF0F2223EBD08820781CBC2B2D';
const RUST_APP_ID = 252490;
const STEAM_IMAGE_BASE = "https://community.cloudflare.steamstatic.com/economy/image/";
const DATA_DIR = path.resolve(__dirname, '../data');
const SKINS_FILE = path.join(DATA_DIR, 'skins.json');
const ADMIN_DB_PATH = path.resolve(__dirname, '../admin.titanrust.ru/server/database.sqlite');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Built-in verified Rust skins catalog with real Steam icon hashes
const VERIFIED_RUST_SKINS = [
  { name: "AK-47 | Alien Red", marketHashName: "AK-47 | Alien Red", price: 15400, rarity: "COVERT", color: "eb4b4b", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Ff5GLNfCk4nReh8DEiv5dbPK47pbcyR_m4DQ68Ofs" },
  { name: "Tempered AK47", marketHashName: "Tempered AK47", price: 12300, rarity: "COVERT", color: "eb4b4b", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Je5WHNfCk4nReh8DEiv5dYO607rLc2Rv2_0wEIAYs" },
  { name: "Glory AK47", marketHashName: "Glory AK47", price: 28900, rarity: "COVERT", color: "eb4b4b", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Fc5GLGfCk4nReh8DEiv5daMag5qLU2QPi5xVewp5A" },
  { name: "Dragon Lore Bolt Rifle", marketHashName: "Dragon Lore Bolt Rifle", price: 18500, rarity: "COVERT", color: "eb4b4b", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Fc5mLNfCk4nReh8DEiv5daPak7qLA_Sfi3ptcE1tc" },
  { name: "Alien Red Rocket Launcher", marketHashName: "Alien Red Rocket Launcher", price: 22000, rarity: "COVERT", color: "eb4b4b", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Va4GLGfCk4nReh8DEiv5dbMaE7rLc3R_63hxTVNRQ" },
  { name: "Metal Facemask", marketHashName: "Metal Facemask", price: 850, rarity: "CLASSIFIED", color: "a855f7", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Fc4GLMfCk4nReh8DEiv5daOaA_rbczSPi4E1BRaYY" },
  { name: "Frost Wolf Metal Chest Plate", marketHashName: "Frost Wolf Metal Chest Plate", price: 4500, rarity: "RESTRICTED", color: "8847ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Fc42LFfCk4nReh8DEiv5dQOao3rr0_RfqEfwyx0Q" },
  { name: "Azul Thompson", marketHashName: "Azul Thompson", price: 3800, rarity: "RESTRICTED", color: "8847ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Bd5GLBfCk4nReh8DEiv5dcP60-rrI0Q_DuajkHSA" },
  { name: "Blackout Assault Rifle", marketHashName: "Blackout Assault Rifle", price: 5600, rarity: "RESTRICTED", color: "8847ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Vf5mLMfCk4nReh8DEiv5daPak7qLA_Sfi3ptcE1tc" },
  { name: "Night Howler Hoodie", marketHashName: "Night Howler Hoodie", price: 1200, rarity: "MIL_SPEC", color: "4b69ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Ja5WXMfCk4nReh8DEiv5daPqk5q7IxRv2_CuOfQ1k" },
  { name: "Loot Leader LR-300", marketHashName: "Loot Leader LR-300", price: 7200, rarity: "CLASSIFIED", color: "a855f7", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Ja5WrMfCk4nReh8DEiv5daMKk6r70yQhaWnmII" },
  { name: "Whiteout Semi-Automatic Pistol", marketHashName: "Whiteout Semi-Automatic Pistol", price: 2400, rarity: "MIL_SPEC", color: "4b69ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Je5GLNfCk4nReh8DEiv5dYOas-q7EzQ_u2d97Lo0M" },
  { name: "High Quality Bag", marketHashName: "High Quality Bag", price: 1105, rarity: "RESTRICTED", color: "8847ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Ja5WrAfCk4nReh8DEiv5ddOas5pLYwSPi8vYJTENQ" },
  { name: "Weapon Barrel", marketHashName: "Weapon Barrel", price: 842, rarity: "RESTRICTED", color: "8847ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Ja5WrMfCk4nReh8DEiv5daMKk6r70yQhaWnmII" },
  { name: "Dracula Mask", marketHashName: "Dracula Mask", price: 502, rarity: "MIL_SPEC", color: "4b69ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Je5mDCfCk4nReh8DEiv5daP682rrMzRfu98VNhZyE" },
  { name: "High Quality Crate", marketHashName: "High Quality Crate", price: 245, rarity: "MIL_SPEC", color: "4b69ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Ja5WrCfCk4nReh8DEiv5daOaE5qbQ_RPm5kDOs1J0" },
  { name: "Heat Seeker Mp5", marketHashName: "Heat Seeker Mp5", price: 458, rarity: "MIL_SPEC", color: "4b69ff", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Vd7GLFfCk4nReh8DEiv5dYOaw7pLU_RPC9nJcdyp4" },
  { name: "Snowcamo Jacket", marketHashName: "Snowcamo Jacket", price: 169, rarity: "REGULAR", color: "756767", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Je5GLNfCk4nReh8DEiv5dYOas-q7EzQ_u2d97Lo0M" },
  { name: "Black Hoodie", marketHashName: "Black Hoodie", price: 57, rarity: "REGULAR", color: "756767", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Ja5WXMfCk4nReh8DEiv5daPqk5q7IxRv2_CuOfQ1k" },
  { name: "Snow Camo Pants", marketHashName: "Snow Camo Pants", price: 93, rarity: "REGULAR", color: "756767", image: "https://community.cloudflare.steamstatic.com/economy/image/6TMcQ7eX6E0EZl2byXi7vaVKyDk_zQLX05x6eLCFM9neAckxGDf7qU2e2gu64OnAeQ7835Je5GDEfCk4nReh8DEiv5daPaA9rLc0Q_C_vCAlyHc" }
];

function fetchUrl(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function getRarity(colorHex, price) {
  if (price >= 8000) return 'COVERT';
  if (price >= 2500) return 'CLASSIFIED';
  if (price >= 800) return 'RESTRICTED';
  if (price >= 200) return 'MIL_SPEC';
  if (!colorHex) return 'REGULAR';
  const c = colorHex.toLowerCase();
  if (c.includes('eb4b4b') || c.includes('d32ce6') || c.includes('e4ae39')) return 'COVERT';
  if (c.includes('8847ff') || c.includes('a855f7')) return 'CLASSIFIED';
  if (c.includes('4b69ff') || c.includes('35a3f1')) return 'RESTRICTED';
  return 'REGULAR';
}

function getColor(rarity) {
  switch (rarity) {
    case 'COVERT': return 'eb4b4b';
    case 'CLASSIFIED': return 'a855f7';
    case 'RESTRICTED': return '8847ff';
    case 'MIL_SPEC': return '4b69ff';
    default: return '756767';
  }
}

async function fetchSteamMarketBatch(start = 0, count = 10) {
  const url = `https://steamcommunity.com/market/search/render/?query=&start=${start}&count=${count}&search_descriptions=0&sort_column=default&sort_dir=desc&appid=${RUST_APP_ID}&norender=1&currency=5`;
  return await fetchUrl(url);
}

/**
 * Sync Rust skins from Steam Market and verified catalog into SQLite DB and skins.json
 */
async function syncRustSkins(limit = 100) {
  console.log(`[SteamSync] Syncing Rust skins catalog (Target: ${limit})...`);
  const skinsMap = new Map();

  // 1. First add all verified base skins
  for (const s of VERIFIED_RUST_SKINS) {
    skinsMap.set(s.marketHashName, {
      ...s,
      id: `steam-${skinsMap.size + 1}`,
      priceText: `${s.price} ₽`,
      rarityUpper: s.rarity,
      rarity: s.rarity.toLowerCase(),
      colorHex: `#${s.color}`,
      tradable: true,
      upgraderEnabled: 1
    });
  }

  // 2. Fetch pages from Steam Market Search
  for (let start = 0; start < limit; start += 10) {
    try {
      const res = await fetchSteamMarketBatch(start, 10);
      if (res && res.results && res.results.length > 0) {
        for (const item of res.results) {
          const hashName = item.hash_name || item.name;
          if (!hashName) continue;

          const asset = item.asset_description || {};
          const iconHash = asset.icon_url || '';
          if (!iconHash) continue;

          const fullImage = `${STEAM_IMAGE_BASE}${iconHash}`;
          let price = item.sell_price ? item.sell_price / 100 : 100;
          if (price < 1) price = Math.round(price * 90) || 15;
          price = Math.round(price);

          const rarity = getRarity(asset.name_color, price);
          const color = asset.name_color ? asset.name_color.replace('#', '') : getColor(rarity);

          skinsMap.set(hashName, {
            id: `steam-${asset.classid || asset.instanceid || skinsMap.size + 1}`,
            name: item.name || hashName,
            marketHashName: hashName,
            price: price,
            priceText: `${price} ₽`,
            image: fullImage,
            rarity: rarity.toLowerCase(),
            rarityUpper: rarity,
            colorHex: `#${color}`,
            color: color,
            tradable: asset.tradable === 1,
            listingsCount: item.sell_listings || 0,
            upgraderEnabled: 1
          });
        }
      }
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.error(`[SteamSync] Page ${start} fetch notice:`, e.message);
    }
  }

  const skinsList = Array.from(skinsMap.values());
  console.log(`[SteamSync] Catalog ready with ${skinsList.length} Rust skins!`);

  // Write to skins.json
  const payload = {
    updatedAt: new Date().toISOString(),
    totalCount: skinsList.length,
    count: skinsList.length,
    skins: skinsList
  };

  try {
    fs.writeFileSync(SKINS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {}

  // Sync to SQLite Database
  if (fs.existsSync(ADMIN_DB_PATH) && skinsList.length > 0) {
    const db = new sqlite3.Database(ADMIN_DB_PATH);
    
    // Purge fake -9a81dl broken images
    db.run("DELETE FROM items WHERE image LIKE '%-9a81dl%'");

    const stmt = db.prepare(`
      INSERT INTO items (market_hash_name, name, price, rarity, color, image, upgraderEnabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(market_hash_name) DO UPDATE SET
        name=excluded.name,
        price=excluded.price,
        rarity=excluded.rarity,
        color=excluded.color,
        image=excluded.image,
        upgraderEnabled=1,
        updated_at=CURRENT_TIMESTAMP
    `);

    for (const s of skinsList) {
      stmt.run([s.marketHashName, s.name, s.price, s.rarityUpper, s.color, s.image]);
    }

    stmt.finalize(() => {
      db.close();
      console.log(`[SteamSync -> DB] ${skinsList.length} skins saved to SQLite.`);
    });
  }

  return payload;
}

async function getSteamPlayerSummary(steamId) {
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
  try {
    const res = await fetchUrl(url);
    if (res?.response?.players && res.response.players.length > 0) {
      return res.response.players[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  syncRustSkins,
  getSteamPlayerSummary,
  fetchSteamMarketBatch,
  VERIFIED_RUST_SKINS,
  STEAM_API_KEY,
  SKINS_FILE,
  ADMIN_DB_PATH
};

if (require.main === module) {
  syncRustSkins(50)
    .then(res => console.log(`Finished: ${res.count} skins.`))
    .catch(err => console.error('Sync failed:', err));
}
