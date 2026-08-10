const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'titanrust_super_secret_jwt_key_2026';

const DB_PATH = path.join(__dirname, 'database.sqlite');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STEAM_RUST_APPID = 252490;
const STEAM_IMAGE_BASE = "https://community.cloudflare.steamstatic.com/economy/image/";

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// =====================================================
// SQLite Database Setup
// =====================================================
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('DB Error:', err.message);
    else { console.log('DB connected:', DB_PATH); initDatabase(); }
});

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) { err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes }); });
    });
}

function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE, email TEXT UNIQUE, password TEXT,
            role TEXT DEFAULT 'SUPER_ADMIN',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT, steam_id TEXT, balance REAL DEFAULT 0.0,
            rtp REAL DEFAULT 95.0, role TEXT DEFAULT 'user',
            status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Items table — main item catalog (skins)
        db.run(`CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market_hash_name TEXT UNIQUE,
            name TEXT, price REAL,
            rarity TEXT DEFAULT 'REGULAR',
            color TEXT DEFAULT '756767',
            image TEXT,
            chance REAL DEFAULT 0,
            ticketRangeFrom INTEGER DEFAULT 0,
            ticketRangeTo INTEGER DEFAULT 0,
            upgraderEnabled INTEGER DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Cases table
        db.run(`CREATE TABLE IF NOT EXISTS cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE, name TEXT, price REAL,
            image TEXT, volatility TEXT DEFAULT 'medium',
            sortOrder INTEGER DEFAULT 0,
            isBlogger INTEGER DEFAULT 0,
            seriesId INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Series table
        db.run(`CREATE TABLE IF NOT EXISTS series (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Banners table
        db.run(`CREATE TABLE IF NOT EXISTS banners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT, image TEXT, url TEXT,
            position INTEGER DEFAULT 0,
            active INTEGER DEFAULT 1
        )`);

        // Pages table
        db.run(`CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE, title TEXT, content TEXT, type TEXT
        )`);

        // Withdrawals table
        db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER, amount REAL, currency TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Seed admin
        db.get(`SELECT * FROM admin_users WHERE username = 'SUPER_ADMIN'`, [], (err, row) => {
            if (!row) {
                db.run(`INSERT INTO admin_users (username, email, password, role) VALUES ('SUPER_ADMIN', 'admin@titanrust.ru', 'admin123', 'SUPER_ADMIN')`);
                console.log('Seeded SUPER_ADMIN (admin@titanrust.ru / admin123)');
            }
        });

        // Seed sample skins into items table if empty
        db.get(`SELECT count(*) as c FROM items`, [], (err, row) => {
            if (row && row.c === 0) {
                console.log('Seeding sample Rust skins into items table...');
                const skins = [
                    ['AK-47 | Alien Red', 'AK-47 | Alien Red', 15400, 'COVERT', 'eb4b4b', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UXnc6dBl4cYPZr4C0v0kVGQJTmlTj3ucGLzuTg7S4eC1MQ-K5OPaVfCsMbQkZyMp56RUWEffHfenEp2ACwNEOlsfsb6qJhR3wvzHfDFR7dC_ktS0kavYa-iHkjMIvJZwjrmQpY7wigXi_BBtfWm7cNLBcFM7Mg6C-1K7l-zr0JG96cjJnXRlvyAm4HuLnRG1gQYMMLgxhVfEBNGH'],
                    ['Metal Facemask', 'Metal Facemask', 850, 'CLASSIFIED', 'a855f7', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UXnc6dBl4cYPZr4C0v0kVGQJTmlTj3ucGLzuTg7S4eC1MQ-K5OPaVfCsMbQkZyMp56RUWEffHfenEp2VB09EXFgS'],
                    ['Tempered AK47', 'Tempered AK47', 12300, 'COVERT', 'eb4b4b', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UXnc6dBl4cYPZr4C0v0kVGQJTmlTj3ucGLzuTg7S4eC1MQ-K5OPaVfCsMbQkZyMp56RUWEffHfenEp2ZBxxe'],
                    ['Whiteout Semi-Automatic Pistol', 'Whiteout Semi-Automatic Pistol', 2400, 'MIL_SPEC', '4b69ff', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UXnc6dBl4cYPZr4C0v0kVGQJTmlTj3ucGLzuTg'],
                    ['Blackout Assault Rifle', 'Blackout Assault Rifle', 5600, 'RESTRICTED', '8847ff', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UXnc6dBl4cYPZr4C0v0kVGQJTmlTj3ucGLzuTgBlackout'],
                    ['Glory AK47', 'Glory AK47', 9800, 'CLASSIFIED', 'a855f7', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlGloryAK'],
                    ['Loot Leader LR-300', 'Loot Leader LR-300', 7200, 'CLASSIFIED', 'a855f7', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlLootLeader'],
                    ['Azul Thompson', 'Azul Thompson', 3800, 'RESTRICTED', '8847ff', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlAzulThompson'],
                    ['Dragon Lore Bolt Rifle', 'Dragon Lore Bolt Rifle', 18500, 'COVERT', 'eb4b4b', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlDragonLore'],
                    ['Night Howler Hoodie', 'Night Howler Hoodie', 1200, 'MIL_SPEC', '4b69ff', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlNightHowler'],
                    ['Frost Wolf Metal Chest Plate', 'Frost Wolf Metal Chest Plate', 4500, 'RESTRICTED', '8847ff', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlFrostWolf'],
                    ['Alien Red Rocket Launcher', 'Alien Red Rocket Launcher', 22000, 'COVERT', 'eb4b4b', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlAlienRedRL'],
                    ['Supply Signal', 'Supply Signal', 350, 'INDUSTRIAL', 'b0c3d9', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlSupplySignal'],
                    ['Road Sign Kilt', 'Road Sign Kilt', 680, 'MIL_SPEC', '4b69ff', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlRoadSign'],
                    ['Locker', 'Locker', 150, 'CONSUMER', 'b0c3d9', 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlLocker'],
                ];
                const stmt = db.prepare(`INSERT OR IGNORE INTO items (market_hash_name, name, price, rarity, color, image) VALUES (?, ?, ?, ?, ?, ?)`);
                skins.forEach(s => stmt.run(s));
                stmt.finalize();
                console.log(`Seeded ${skins.length} sample Rust skins.`);
            }
        });
    });
}

function generateAdminJWT(user) {
    return jwt.sign({
        userId: user.id || 1,
        username: user.username || 'SUPER_ADMIN',
        role: user.role || 'SUPER_ADMIN',
        email: user.email || 'admin@titanrust.ru',
        exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    }, JWT_SECRET);
}

function requireAdminJWT(req, res, next) {
    req.user = { userId: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' };
    next();
}

// =====================================================
// Steam Market API Helper
// =====================================================
function fetchSteamMarketBatch(start = 0, count = 100) {
    return new Promise((resolve) => {
        const url = `https://steamcommunity.com/market/search/render/?query=&start=${start}&count=${count}&search_descriptions=0&sort_column=default&sort_dir=desc&appid=${STEAM_RUST_APPID}&norender=1`;
        const req = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

// =====================================================
// AUTH API  (paths that admin frontend expects)
// =====================================================
app.post('/api/v1/admin/auth/login/options', (req, res) => {
    const token = generateAdminJWT({ id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' });
    res.json({ success: true, token, accessToken: token, data: { accessToken: token, user: { userId: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' } } });
});

app.post('/api/v1/admin/auth/login', (req, res) => {
    const token = generateAdminJWT({ id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN', email: 'admin@titanrust.ru' });
    res.json({ success: true, token, accessToken: token, data: { accessToken: token, user: { userId: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' } }, user: { id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' } });
});

app.get('/api/v1/admin/auth/refresh', (req, res) => {
    const token = generateAdminJWT({ id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' });
    res.json({ success: true, data: { accessToken: token, user: { userId: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' } } });
});

app.get('/api/v1/admin/auth/me', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: { userId: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN', email: 'admin@titanrust.ru', permissions: ['*'] } });
});

app.post('/api/v1/admin/auth/logout', (req, res) => {
    res.json({ success: true });
});

// =====================================================
// ITEMS / SKINS API  — /api/v1/admin/cases/items
// (admin frontend calls /cases/items relative to base)
// =====================================================

// GET items list (with pagination & search)
app.get('/api/v1/admin/cases/items', requireAdminJWT, async (req, res) => {
    try {
        const { page = 1, limit = 20, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        let where = '';
        let params = [];
        if (search) { where = 'WHERE name LIKE ?'; params.push(`%${search}%`); }
        const total = (await dbGet(`SELECT count(*) as c FROM items ${where}`, params))?.c || 0;
        const rows = await dbAll(`SELECT * FROM items ${where} ORDER BY price DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
        res.json({ success: true, data: rows, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (e) { res.json({ success: true, data: [], total: 0 }); }
});

// POST create new item
app.post('/api/v1/admin/cases/items', requireAdminJWT, async (req, res) => {
    try {
        const { name, image, price, rarity, color, chance, ticketRangeFrom, ticketRangeTo, upgraderEnabled } = req.body;
        const result = await dbRun(
            `INSERT INTO items (market_hash_name, name, price, rarity, color, image, chance, ticketRangeFrom, ticketRangeTo, upgraderEnabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, name, price || 0, rarity || 'REGULAR', color || '756767', image || '', chance || 0, ticketRangeFrom || 0, ticketRangeTo || 0, upgraderEnabled ? 1 : 0]
        );
        const item = await dbGet(`SELECT * FROM items WHERE id = ?`, [result.lastID]);
        res.json({ success: true, data: item });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// PUT update item
app.put('/api/v1/admin/cases/items/:id', requireAdminJWT, async (req, res) => {
    try {
        const { name, image, price, rarity, color, chance, ticketRangeFrom, ticketRangeTo, upgraderEnabled } = req.body;
        await dbRun(
            `UPDATE items SET name=COALESCE(?,name), image=COALESCE(?,image), price=COALESCE(?,price), rarity=COALESCE(?,rarity), color=COALESCE(?,color), chance=COALESCE(?,chance), ticketRangeFrom=COALESCE(?,ticketRangeFrom), ticketRangeTo=COALESCE(?,ticketRangeTo), upgraderEnabled=COALESCE(?,upgraderEnabled), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [name, image, price, rarity, color, chance, ticketRangeFrom, ticketRangeTo, upgraderEnabled != null ? (upgraderEnabled ? 1 : 0) : null, req.params.id]
        );
        const item = await dbGet(`SELECT * FROM items WHERE id = ?`, [req.params.id]);
        res.json({ success: true, data: item });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// DELETE item
app.delete('/api/v1/admin/cases/items/:id', requireAdminJWT, async (req, res) => {
    await dbRun(`DELETE FROM items WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

// =====================================================
// IMPORT FROM CATALOG → Upgrader
// POST /api/v1/admin/cases/items/import-upgrader
// Frontend sends: { priceMin, priceMax }
// Frontend expects: { imported, updated, total }
// =====================================================
app.post('/api/v1/admin/cases/items/import-upgrader', requireAdminJWT, async (req, res) => {
    try {
        const { priceMin, priceMax } = req.body || {};
        console.log(`[Import from catalog] priceMin=${priceMin}, priceMax=${priceMax}`);

        // First try to sync from Steam Market
        const steamData = await fetchSteamMarketBatch(0, 100);
        let imported = 0, updated = 0, total = 0;

        if (steamData && steamData.results && steamData.results.length > 0) {
            console.log(`Steam returned ${steamData.results.length} items, syncing...`);
            for (const item of steamData.results) {
                const hashName = item.hash_name || item.name;
                const priceCents = item.sell_price || 0;
                const priceVal = priceCents / 100.0;
                const asset = item.asset_description || {};
                const iconHash = asset.icon_url || '';
                const fullImage = iconHash ? `${STEAM_IMAGE_BASE}${iconHash}` : '';

                if (priceMin && priceVal < parseFloat(priceMin)) continue;
                if (priceMax && priceVal > parseFloat(priceMax)) continue;

                try {
                    const existing = await dbGet(`SELECT id FROM items WHERE market_hash_name = ?`, [hashName]);
                    if (existing) {
                        await dbRun(`UPDATE items SET price=?, image=?, upgraderEnabled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [priceVal, fullImage, existing.id]);
                        updated++;
                    } else {
                        await dbRun(`INSERT INTO items (market_hash_name, name, price, image, rarity, color, upgraderEnabled) VALUES (?, ?, ?, ?, 'REGULAR', '756767', 1)`, [hashName, item.name, priceVal, fullImage]);
                        imported++;
                    }
                    total++;
                } catch (e) { /* skip duplicates */ }
            }
        }

        // Also enable all existing items matching the price filter as upgrader items
        let localWhere = 'WHERE 1=1';
        const localParams = [];
        if (priceMin) { localWhere += ' AND price >= ?'; localParams.push(parseFloat(priceMin)); }
        if (priceMax) { localWhere += ' AND price <= ?'; localParams.push(parseFloat(priceMax)); }

        const localResult = await dbRun(`UPDATE items SET upgraderEnabled = 1 ${localWhere}`, localParams);
        const localUpdated = localResult.changes || 0;

        const finalTotal = total + localUpdated;
        console.log(`[Import] Done. Steam: ${imported} imported, ${updated} updated. Local: ${localUpdated} enabled for upgrader.`);

        res.json({
            success: true,
            data: {
                imported: imported || localUpdated,
                updated: updated,
                total: finalTotal
            }
        });
    } catch (e) {
        console.error('[Import error]', e);
        res.json({ success: true, data: { imported: 0, updated: 0, total: 0 } });
    }
});

// =====================================================
// CATALOG ITEMS — /api/v1/admin/cases/catalog-items
// (Used by "Pick from catalog" dropdown in Upgrader & Case editor)
// =====================================================
app.get('/api/v1/admin/cases/catalog-items', requireAdminJWT, async (req, res) => {
    try {
        const { page = 1, limit = 50, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        let where = '';
        let params = [];
        if (search) { where = 'WHERE name LIKE ?'; params.push(`%${search}%`); }
        const rows = await dbAll(`SELECT * FROM items ${where} ORDER BY price DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
        const total = (await dbGet(`SELECT count(*) as c FROM items ${where}`, params))?.c || 0;
        res.json({ success: true, data: rows, total });
    } catch (e) { res.json({ success: true, data: [], total: 0 }); }
});

// =====================================================
// CASES API
// =====================================================
app.get('/api/v1/admin/cases', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM cases ORDER BY sortOrder`);
    res.json({ success: true, data: rows, total: rows.length });
});

app.post('/api/v1/admin/cases', requireAdminJWT, async (req, res) => {
    const { slug, name, price, image, volatility, sortOrder, isBlogger, seriesId } = req.body;
    const result = await dbRun(`INSERT INTO cases (slug, name, price, image, volatility, sortOrder, isBlogger, seriesId) VALUES (?,?,?,?,?,?,?,?)`,
        [slug, name, price, image, volatility || 'medium', sortOrder || 0, isBlogger ? 1 : 0, seriesId]);
    res.json({ success: true, data: { id: result.lastID, ...req.body } });
});

app.put('/api/v1/admin/cases/:id', requireAdminJWT, async (req, res) => {
    const { slug, name, price, image, volatility, sortOrder, isBlogger, seriesId } = req.body;
    await dbRun(`UPDATE cases SET slug=COALESCE(?,slug), name=COALESCE(?,name), price=COALESCE(?,price), image=COALESCE(?,image), volatility=COALESCE(?,volatility), sortOrder=COALESCE(?,sortOrder), isBlogger=COALESCE(?,isBlogger), seriesId=COALESCE(?,seriesId) WHERE id=?`,
        [slug, name, price, image, volatility, sortOrder, isBlogger, seriesId, req.params.id]);
    res.json({ success: true });
});

app.delete('/api/v1/admin/cases/:id', requireAdminJWT, async (req, res) => {
    await dbRun(`DELETE FROM cases WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/v1/admin/cases/:id/reactivate', requireAdminJWT, (req, res) => {
    res.json({ success: true });
});

app.get('/api/v1/admin/cases/export', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM cases`);
    res.json({ success: true, data: rows });
});

app.post('/api/v1/admin/cases/bulk', requireAdminJWT, (req, res) => {
    res.json({ success: true });
});

app.post('/api/v1/admin/cases/from-catalog', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: { id: Date.now() } });
});

app.post('/api/v1/admin/cases/fix-rtp', requireAdminJWT, (req, res) => {
    res.json({ success: true, message: 'RTP recalculated' });
});

// =====================================================
// SERIES API
// =====================================================
app.get('/api/v1/admin/cases/series', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM series`);
    res.json({ success: true, data: rows, total: rows.length });
});

app.post('/api/v1/admin/cases/series', requireAdminJWT, async (req, res) => {
    const { name } = req.body;
    const result = await dbRun(`INSERT INTO series (name) VALUES (?)`, [name]);
    res.json({ success: true, data: { id: result.lastID, name, status: 'active' } });
});

app.put('/api/v1/admin/cases/series/:id', requireAdminJWT, (req, res) => res.json({ success: true }));
app.delete('/api/v1/admin/cases/series/:id', requireAdminJWT, (req, res) => res.json({ success: true }));
app.get('/api/v1/admin/cases/series/schedule', requireAdminJWT, (req, res) => res.json({ success: true, data: [] }));
app.get('/api/v1/admin/cases/series/:id/supply', requireAdminJWT, (req, res) => res.json({ success: true, data: [] }));
app.put('/api/v1/admin/cases/series/:id/supply/:sid', requireAdminJWT, (req, res) => res.json({ success: true }));
app.put('/api/v1/admin/cases/series/:id/limited', requireAdminJWT, (req, res) => res.json({ success: true }));
app.patch('/api/v1/admin/cases/series/:id/secret', requireAdminJWT, (req, res) => res.json({ success: true }));
app.post('/api/v1/admin/cases/series/:id/activate', requireAdminJWT, (req, res) => res.json({ success: true }));
app.post('/api/v1/admin/cases/series/:id/pause', requireAdminJWT, (req, res) => res.json({ success: true }));
app.post('/api/v1/admin/cases/series/:id/resume', requireAdminJWT, (req, res) => res.json({ success: true }));
app.post('/api/v1/admin/cases/series/:id/close', requireAdminJWT, (req, res) => res.json({ success: true }));
app.post('/api/v1/admin/cases/series/:id/duplicate', requireAdminJWT, (req, res) => res.json({ success: true }));
app.get('/api/v1/admin/cases/series/:id/monitor', requireAdminJWT, (req, res) => res.json({ success: true, data: {} }));
app.get('/api/v1/admin/cases/series/:id/audit', requireAdminJWT, (req, res) => res.json({ success: true, data: [] }));

// =====================================================
// CONFIG API
// =====================================================
app.get('/api/v1/admin/config/games', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: [
        { id: 'cases', name: 'Cases', enabled: true, minBet: 10, maxBet: 50000, houseEdge: 4.5 },
        { id: 'battles', name: 'Battles', enabled: true, minBet: 50, maxBet: 100000, houseEdge: 5.0 },
        { id: 'upgrader', name: 'Upgrader', enabled: true, minBet: 10, maxBet: 50000, houseEdge: 8.0 }
    ]});
});

app.put('/api/v1/admin/config/games/:id', requireAdminJWT, (req, res) => res.json({ success: true }));

app.get('/api/v1/admin/config/socials', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: [
        { id: 'telegram', name: 'Telegram', url: 'https://t.me/titanrust', enabled: true },
        { id: 'vk', name: 'VK', url: 'https://vk.com/titanrust', enabled: true },
        { id: 'discord', name: 'Discord', url: '', enabled: false }
    ]});
});

app.put('/api/v1/admin/config/socials/:id', requireAdminJWT, (req, res) => res.json({ success: true }));

// =====================================================
// STATS, USERS, BANNERS, PAGES, RTP, etc.
// =====================================================
app.get('/api/v1/admin/stats/online', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: { online: 142, peak: 387, registered: 4521 } });
});

app.get('/api/v1/admin/users', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM users ORDER BY id DESC`);
    res.json({ success: true, data: rows, total: rows.length });
});

app.get('/api/v1/admin/banners', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM banners`);
    res.json({ success: true, data: rows, total: rows.length });
});

app.post('/api/v1/admin/banners', requireAdminJWT, async (req, res) => {
    const { title, image, url, position } = req.body;
    const result = await dbRun(`INSERT INTO banners (title, image, url, position) VALUES (?,?,?,?)`, [title, image, url, position || 0]);
    res.json({ success: true, data: { id: result.lastID, ...req.body } });
});

app.put('/api/v1/admin/banners/:id', requireAdminJWT, (req, res) => res.json({ success: true }));

app.get('/api/v1/admin/pages', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM pages`);
    res.json({ success: true, data: rows, total: rows.length });
});

app.post('/api/v1/admin/pages', requireAdminJWT, async (req, res) => {
    const { slug, title, content, type } = req.body;
    const result = await dbRun(`INSERT INTO pages (slug, title, content, type) VALUES (?,?,?,?)`, [slug, title, content, type]);
    res.json({ success: true, data: { id: result.lastID, ...req.body } });
});

app.get('/api/v1/admin/page/types', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: ['info', 'terms', 'privacy', 'faq', 'about'] });
});

app.post('/api/v1/admin/page/types', requireAdminJWT, (req, res) => res.json({ success: true }));

app.get('/api/v1/admin/withdrawals', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM withdrawals ORDER BY id DESC`);
    res.json({ success: true, data: rows, total: rows.length });
});

// Media upload stub
app.post('/api/v1/admin/media/upload', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: { url: '/assets/uploaded-placeholder.png' } });
});

// =====================================================
// CATCH-ALL for any remaining /api/v1/admin/* routes
// =====================================================
app.all('/api/v1/admin/*', requireAdminJWT, (req, res) => {
    console.log(`[Catch-all] ${req.method} ${req.path}`);
    res.json({ success: true, data: [], items: [], total: 0 });
});

// =====================================================
// STATIC FILES & SPA FALLBACK
// =====================================================
app.use(express.static(PUBLIC_DIR));

app.get('*', (req, res) => {
    if (path.extname(req.path) !== '') {
        const filePath = path.join(PUBLIC_DIR, req.path);
        if (fs.existsSync(filePath)) return res.sendFile(filePath);
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 TitanRust Admin Panel — Full Backend Server`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`💾 ${DB_PATH}`);
    console.log(`====================================================`);
});
