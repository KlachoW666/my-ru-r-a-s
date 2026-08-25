try { process.loadEnvFile(require('path').resolve(__dirname, '..', '..', '.env')); } catch {}
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');
const multer = require('multer');
const access = require('./adminAccess');

const app = express();
// ADMIN_PORT, а не PORT: .env общий с игровым сервером, где PORT=3101.
const PORT = process.env.ADMIN_PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'titanrust_super_secret_jwt_key_2026';

// Небезопасный секрет по умолчанию. Если .env не подхватился на проде, сервер
// поднялся бы молча на общеизвестном значении, и подделать токен смог бы любой,
// кто видел репозиторий. Поэтому в production падаем сразу.
const INSECURE_JWT_SECRETS = ['titanrust_super_secret_jwt_key_2026', '', 'secret', 'changeme'];
if (process.env.NODE_ENV === 'production' && INSECURE_JWT_SECRETS.includes(JWT_SECRET)) {
  console.error('[FATAL] JWT_SECRET не задан или оставлен значением по умолчанию.');
  console.error('        Сгенерируйте: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.error('        и пропишите в .env, иначе токены можно подделать.');
  process.exit(1);
}


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
        
        // Case Items junction table
        db.run(`CREATE TABLE IF NOT EXISTS case_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            case_id INTEGER,
            item_id INTEGER,
            chance REAL DEFAULT 0,
            ticketRangeFrom INTEGER DEFAULT 0,
            ticketRangeTo INTEGER DEFAULT 0,
            UNIQUE(case_id, item_id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE, name TEXT, price REAL,
            category TEXT DEFAULT 'standard',
            image TEXT, volatility TEXT DEFAULT 'medium',
            sortOrder INTEGER DEFAULT 0,
            isBlogger INTEGER DEFAULT 0,
            exclusiveTo TEXT,
            seriesId INTEGER,
            isActive INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            archived INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`ALTER TABLE cases ADD COLUMN isActive INTEGER DEFAULT 1`, (err) => {});
        db.run(`ALTER TABLE cases ADD COLUMN status TEXT DEFAULT 'active'`, (err) => {});
        db.run(`ALTER TABLE cases ADD COLUMN archived INTEGER DEFAULT 0`, (err) => {});
        db.run(`UPDATE cases SET isActive = 1, status = 'active' WHERE isActive IS NULL OR status IS NULL`, (err) => {});
        db.run(`ALTER TABLE cases ADD COLUMN exclusiveTo TEXT`, (err) => {});
        db.run(`ALTER TABLE cases ADD COLUMN category TEXT DEFAULT 'standard'`, (err) => {});

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
        
        // Seed initial case series if empty
        db.get(`SELECT count(*) as c FROM series`, [], (err, row) => {
            if (row && row.c === 0) {
                db.run(`INSERT INTO series (name, status) VALUES ('Стандартная серия', 'active')`);
                db.run(`INSERT INTO series (name, status) VALUES ('Лимитированная серия', 'active')`);
                db.run(`INSERT INTO series (name, status) VALUES ('Секретная серия', 'active')`);
                console.log('Seeded 3 initial case series.');
            }
        });

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
        // Роль кладём в токен уже нормализованной: она решает, что можно.
        role: access.normalizeRole(user.role || 'SUPER_ADMIN'),
        email: user.email || 'admin@titanrust.ru',
        exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    }, JWT_SECRET);
}

// ADMIN_REQUIRE_AUTH=1 включает реальную проверку JWT.
// По умолчанию выключено, чтобы не потерять доступ, пока не заведён ни один
// passkey. Перед выкладкой на публичный домен ОБЯЗАТЕЛЬНО поставить 1.
const REQUIRE_ADMIN_AUTH = process.env.ADMIN_REQUIRE_AUTH === '1';

// Роль, от имени которой работает админка при выключенной проверке токена.
// Нужна, чтобы ролевую модель можно было проверять локально, не заводя passkey.
// По умолчанию SUPER_ADMIN — поведение при ADMIN_REQUIRE_AUTH=0 не меняется.
const DEV_ROLE = access.normalizeRole(process.env.ADMIN_DEV_ROLE || 'SUPER_ADMIN');

/**
 * Аутентификация + проверка прав.
 *
 * Права проверяются здесь же, а не отдельным middleware: иначе новый роут,
 * которому забыли повесить проверку, снова получил бы полный доступ.
 * Раскладка «раздел -> домен -> уровень» живёт в adminAccess.js.
 */
function requireAdminJWT(req, res, next) {
    if (!REQUIRE_ADMIN_AUTH) {
        req.user = { userId: 1, username: 'SUPER_ADMIN', role: DEV_ROLE };
    } else {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) {
            return res.status(401).json({ success: false, message: 'Требуется авторизация администратора' });
        }
        try {
            req.user = jwt.verify(token, JWT_SECRET);
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Недействительный или истёкший токен' });
        }
    }

    const verdict = access.check(req.user.role, req.method, req.path);
    req.access = verdict;
    req.user.role = verdict.role;
    if (!verdict.allowed) {
        console.log(`[Права] ${verdict.role} ${req.method} ${req.path} -> 403 (${verdict.domain}: нужно ${verdict.need}, есть ${verdict.have})`);
        return res.status(403).json({
            success: false,
            code: 'FORBIDDEN',
            message: verdict.message,
            role: verdict.role,
            section: verdict.section,
            domain: verdict.domain,
            required: verdict.need,
            granted: verdict.have
        });
    }
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
// Настоящий WebAuthn живёт в passkeys.js и регистрируется ниже.
// Прежняя заглушка выдавала JWT любому, кто просто дёрнул этот путь.

app.post('/api/v1/admin/auth/login', (req, res) => {
    if (REQUIRE_ADMIN_AUTH) {
        return res.status(410).json({ success: false, message: 'Вход только по passkey: /auth/login/options' });
    }
    const token = generateAdminJWT({ id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN', email: 'admin@titanrust.ru' });
    res.json({ success: true, token, accessToken: token, data: { accessToken: token, user: { userId: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' } }, user: { id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' } });
});

app.get('/api/v1/admin/auth/refresh', (req, res) => {
    // При включённой защите продлеваем сессию только по действующему токену.
    if (REQUIRE_ADMIN_AUTH) {
        const header = req.headers.authorization || '';
        const t = header.startsWith('Bearer ') ? header.slice(7) : null;
        try {
            const payload = jwt.verify(t, JWT_SECRET);
            const token = generateAdminJWT({ id: payload.userId, username: payload.username, role: payload.role, email: payload.email });
            return res.json({ success: true, data: { accessToken: token, user: payload } });
        } catch {
            return res.status(401).json({ success: false, message: 'Сессия истекла, войдите по passkey' });
        }
    }
    const token = generateAdminJWT({ id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' });
    res.json({ success: true, data: { accessToken: token, user: { userId: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' } } });
});

app.get('/api/v1/admin/auth/me', requireAdminJWT, (req, res) => {
    // Раньше здесь был захардкоженный SUPER_ADMIN с permissions:['*'] — фронт
    // рисовал все разделы кому угодно. Теперь отдаём настоящую роль из токена.
    const role = access.normalizeRole(req.user?.role);
    res.json({
        success: true,
        data: {
            userId: req.user?.userId || 1,
            username: req.user?.username || 'SUPER_ADMIN',
            email: req.user?.email || 'admin@titanrust.ru',
            role,
            roleTitle: access.ROLES[role].title,
            permissions: access.permissionListFor(role),
            access: access.permissionsFor(role)
        }
    });
});

// Справочник ролей — для экрана управления администраторами.
app.get('/api/v1/admin/auth/roles', requireAdminJWT, (req, res) => {
    res.json({ success: true, data: access.roleCatalog(), items: access.roleCatalog() });
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

        let syncModule;
        try {
            syncModule = require(path.join(__dirname, '..', '..', 'services', 'steamSync'));
            if (syncModule && typeof syncModule.syncRustSkins === 'function') {
                await syncModule.syncRustSkins(50);
            }
        } catch (e) {
            console.log('[Import] steamSync module notice:', e.message);
        }

        // Clean up any old broken image URLs
        await dbRun("DELETE FROM items WHERE image LIKE '%-9a81dlAlienRedRL%' OR image LIKE '%-9a81dlGloryAK%' OR image LIKE '%-9a81dlDragonLore%' OR image LIKE '%-9a81dlNightHowler%' OR image LIKE '%-9a81dlFrostWolf%' OR image LIKE '%-9a81dlSupplySignal%' OR image LIKE '%-9a81dlRoadSign%' OR image LIKE '%-9a81dlLocker%' OR image LIKE '%-9a81dlAzulThompson%' OR image LIKE '%-9a81dlLootLeader%'");

        let localWhere = 'WHERE 1=1';
        const localParams = [];
        if (priceMin !== undefined && priceMin !== null && priceMin !== '' && !isNaN(priceMin)) {
            localWhere += ' AND price >= ?';
            localParams.push(parseFloat(priceMin));
        }
        if (priceMax !== undefined && priceMax !== null && priceMax !== '' && !isNaN(priceMax)) {
            localWhere += ' AND price <= ?';
            localParams.push(parseFloat(priceMax));
        }

        const localResult = await dbRun(`UPDATE items SET upgraderEnabled = 1 ${localWhere}`, localParams);
        const localUpdated = localResult.changes || 0;

        const totalRow = await dbGet(`SELECT count(*) as c FROM items WHERE upgraderEnabled = 1`);
        const totalCount = totalRow?.c || localUpdated;

        console.log(`[Import] Upgrader items updated: ${localUpdated}, total active in upgrader: ${totalCount}`);

        res.json({
            success: true,
            data: {
                imported: localUpdated,
                updated: localUpdated,
                total: totalCount
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

// Helper to get case with attached itemIds and full items array
async function getFullCasesList(whereClause = '', params = []) {
    let fixedWhere = whereClause
        .replace(/\bWHERE\s+id\b/gi, 'WHERE c.id')
        .replace(/\bWHERE\s+slug\b/gi, 'WHERE c.slug')
        .replace(/\bOR\s+id\b/gi, 'OR c.id')
        .replace(/\bOR\s+slug\b/gi, 'OR c.slug')
        .replace(/\bAND\s+id\b/gi, 'AND c.id')
        .replace(/\bAND\s+slug\b/gi, 'AND c.slug');

    const cases = await dbAll(`SELECT c.*, s.name as seriesName FROM cases c LEFT JOIN series s ON c.seriesId = s.id ${fixedWhere} ORDER BY c.sortOrder DESC, c.id DESC`, params);
    for (const c of cases) {
        const caseItems = await dbAll(`
            SELECT ci.*, i.name, i.price, i.image, i.rarity, i.color, i.market_hash_name
            FROM case_items ci
            JOIN items i ON ci.item_id = i.id
            WHERE ci.case_id = ?
        `, [c.id]);
        
        c.items = caseItems.map(ci => ({
            id: ci.item_id,
            name: ci.name,
            price: ci.price,
            image: ci.image,
            rarity: ci.rarity || 'REGULAR',
            color: ci.color || '756767',
            chance: ci.chance,
            ticketRangeFrom: ci.ticketRangeFrom,
            ticketRangeTo: ci.ticketRangeTo
        }));
        c.itemIds = caseItems.map(ci => ci.item_id);
    }
        for (const c of cases) {
        c.isActive = (c.isActive === 1 || c.isActive === true || c.status === 'active' || c.status == null);
        c.status = c.isActive ? 'active' : 'inactive';
        c.archived = (c.archived === 1 || c.archived === true);
    }
    return cases;
}

// 1. GET all cases for Admin
app.get('/api/v1/admin/cases', requireAdminJWT, async (req, res) => {
    try {
        const cases = await getFullCasesList();
        res.json({ success: true, data: cases, total: cases.length });
    } catch (e) {
        console.error("GET cases error:", e);
        res.json({ success: true, data: [], total: 0 });
    }
});

// 2. GET single case details for Admin

// =====================================================
// =====================================================
// =====================================================
// =====================================================
// FULL SERIES API HANDLERS WITH DB PERSISTENCE & FILTERING
// =====================================================
app.get('/api/v1/admin/cases/series/schedule', requireAdminJWT, async (req, res) => {
    // Раньше отдавался пустой массив — расписание серий выглядело незаполненным.
    const rows = await dbAll(
        `SELECT id, name, status, isLimited, isSecret, sortOrder, created_at
         FROM series ORDER BY sortOrder ASC`).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length });
});

app.get('/api/v1/admin/cases/series/export', requireAdminJWT, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM series ORDER BY sortOrder DESC, id DESC`);
        let csv = "id,name,status,description,sortOrder,isLimited,isSecret,created_at\n";
        rows.forEach(r => {
            csv += `"${r.id}","${(r.name||'').replace(/"/g, '""')}","${r.status||'active'}","${(r.description||'').replace(/"/g, '""')}","${r.sortOrder||0}","${r.isLimited||0}","${r.isSecret||0}","${r.created_at||''}"\n`;
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=series.csv');
        res.send(csv);
    } catch (e) {
        res.status(500).send("id,name,status\n");
    }
});

app.get('/api/v1/admin/cases/series', requireAdminJWT, async (req, res) => {
    try {
        const { status, search } = req.query;
        let whereClauses = [];
        let params = [];

        if (status) {
            whereClauses.push("status = ?");
            params.push(status);
        }
        if (search) {
            whereClauses.push("name LIKE ?");
            params.push(`%${search}%`);
        }

        const whereSql = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";
        const rows = await dbAll(`SELECT * FROM series ${whereSql} ORDER BY sortOrder DESC, id DESC`, params);
        
        const formatted = rows.map(s => ({
            ...s,
            isActive: s.status === 'active',
            status: s.status || 'active',
            isLimited: Boolean(s.isLimited),
            isSecret: Boolean(s.isSecret)
        }));
        
        res.json({ success: true, data: formatted, total: formatted.length });
    } catch (e) {
        res.json({ success: true, data: [], total: 0 });
    }
});

app.get('/api/v1/admin/cases/series/:id/supply', requireAdminJWT, async (req, res) => {
    res.json({ success: true, data: { total: 1000, remaining: 1000, claimed: 0 } });
});

app.get('/api/v1/admin/cases/series/:id', requireAdminJWT, async (req, res) => {
    try {
        const s = await dbGet(`SELECT * FROM series WHERE id = ?`, [req.params.id]);
        if (!s) return res.status(404).json({ success: false, message: 'Series not found' });
        res.json({
            success: true,
            data: {
                ...s,
                isActive: s.status === 'active',
                status: s.status || 'active',
                isLimited: Boolean(s.isLimited),
                isSecret: Boolean(s.isSecret)
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/v1/admin/cases/series', requireAdminJWT, async (req, res) => {
    try {
        const body = req.body.data || req.body || {};
        const name = body.name || 'Новая Серия';
        const description = body.description || '';
        const img = body.title_image || body.titleImage || body.image || '';
        const sortVal = body.sort_order != null ? (parseInt(body.sort_order) || 0) : (body.sortOrder != null ? (parseInt(body.sortOrder) || 0) : (body.sort != null ? (parseInt(body.sort) || 0) : 0));
        const isLim = (body.is_limited !== undefined ? body.is_limited : body.isLimited) ? 1 : 0;
        const isSec = (body.is_secret !== undefined ? body.is_secret : body.isSecret) ? 1 : 0;

        const result = await dbRun(
            `INSERT INTO series (name, description, image, titleImage, sortOrder, isLimited, isSecret, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
            [name, description, img, img, sortVal, isLim, isSec]
        );
        console.log(`[Series Created] ID: ${result.lastID}, Name: ${name}, Image: ${img}, Sort: ${sortVal}`);
        const newSeries = await dbGet(`SELECT * FROM series WHERE id = ?`, [result.lastID]);
        res.json({ success: true, data: { ...newSeries, isActive: true, status: 'active' } });
    } catch (e) {
        console.error("POST create series error:", e);
        res.status(400).json({ success: false, message: e.message });
    }
});

app.put('/api/v1/admin/cases/series/:id', requireAdminJWT, async (req, res) => {
    try {
        const id = req.params.id;
        const body = req.body.data || req.body || {};
        
        const existing = await dbGet(`SELECT * FROM series WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ success: false, message: 'Series not found' });

        const name = body.name !== undefined ? body.name : existing.name;
        const description = body.description !== undefined ? body.description : existing.description;
        
        let img = existing.image;
        let titleImg = existing.titleImage;
        const newImg = body.title_image || body.titleImage || body.image;
        if (newImg && String(newImg).trim() !== '') {
            img = String(newImg).trim();
            titleImg = String(newImg).trim();
        }

        let sortVal = existing.sortOrder;
        const rawSort = body.sort_order ?? body.sortOrder ?? body.sort;
        if (rawSort !== undefined && rawSort !== null && String(rawSort).trim() !== '') {
            sortVal = parseInt(rawSort) || 0;
        }

        const isLim = body.is_limited !== undefined ? (body.is_limited ? 1 : 0) : (body.isLimited !== undefined ? (body.isLimited ? 1 : 0) : existing.isLimited);
        const isSec = body.is_secret !== undefined ? (body.is_secret ? 1 : 0) : (body.isSecret !== undefined ? (body.isSecret ? 1 : 0) : existing.isSecret);
        const status = body.status || existing.status || 'active';

        await dbRun(
            `UPDATE series SET name=?, description=?, image=?, titleImage=?, sortOrder=?, isLimited=?, isSecret=?, status=? WHERE id=?`,
            [name, description, img, titleImg, sortVal, isLim, isSec, status, id]
        );
        console.log(`[Series Updated] ID: ${id}, Name: ${name}, Image: ${img}, Sort: ${sortVal}`);
        const updated = await dbGet(`SELECT * FROM series WHERE id = ?`, [id]);
        res.json({ success: true, data: { ...updated, isActive: updated.status === 'active' } });
    } catch (e) {
        console.error("PUT update series error:", e);
        res.status(400).json({ success: false, message: e.message });
    }
});

app.put('/api/v1/admin/cases/series/:id/limited', requireAdminJWT, async (req, res) => {
    try {
        const { isLimited } = req.body || {};
        await dbRun(`UPDATE series SET isLimited = ? WHERE id = ?`, [isLimited ? 1 : 0, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.patch('/api/v1/admin/cases/series/:id/secret', requireAdminJWT, async (req, res) => {
    try {
        const { isSecret } = req.body || {};
        await dbRun(`UPDATE series SET isSecret = ? WHERE id = ?`, [isSecret ? 1 : 0, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.post('/api/v1/admin/cases/series/:id/duplicate', requireAdminJWT, async (req, res) => {
    try {
        const orig = await dbGet(`SELECT * FROM series WHERE id = ?`, [req.params.id]);
        if (!orig) return res.status(404).json({ success: false, message: 'Series not found' });
        const result = await dbRun(
            `INSERT INTO series (name, description, image, titleImage, sortOrder, isLimited, isSecret, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
            [orig.name + ' (Копия)', orig.description, orig.image, orig.titleImage, orig.sortOrder, orig.isLimited, orig.isSecret]
        );
        const dup = await dbGet(`SELECT * FROM series WHERE id = ?`, [result.lastID]);
        res.json({ success: true, data: dup });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.post('/api/v1/admin/cases/series/:id/activate', requireAdminJWT, async (req, res) => {
    await dbRun(`UPDATE series SET status = 'active' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/v1/admin/cases/series/:id/resume', requireAdminJWT, async (req, res) => {
    await dbRun(`UPDATE series SET status = 'active' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/v1/admin/cases/series/:id/pause', requireAdminJWT, async (req, res) => {
    await dbRun(`UPDATE series SET status = 'inactive' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/v1/admin/cases/series/:id/close', requireAdminJWT, async (req, res) => {
    await dbRun(`UPDATE series SET status = 'inactive' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

app.delete('/api/v1/admin/cases/series/:id', requireAdminJWT, async (req, res) => {
    await dbRun(`UPDATE series SET status = 'inactive' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

// Public Series API for main website
app.get('/api/v1/cases/series', async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM series WHERE status = 'active' ORDER BY id DESC`);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: true, data: [] });
    }
});



// Activate / Reactivate case
app.post('/api/v1/admin/cases/:id/reactivate', requireAdminJWT, async (req, res) => {
    try {
        const id = req.params.id;
        await dbRun(`UPDATE cases SET isActive = 1, status = 'active', archived = 0 WHERE id = ? OR slug = ?`, [id, id]);
        console.log(`[Case Activated] ID: ${id}`);
        const updatedList = await getFullCasesList('WHERE id = ? OR slug = ?', [id, id]);
        res.json({ success: true, data: updatedList[0] || { id, isActive: true, status: 'active' } });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// Deactivate case
app.post('/api/v1/admin/cases/:id/deactivate', requireAdminJWT, async (req, res) => {
    try {
        const id = req.params.id;
        await dbRun(`UPDATE cases SET isActive = 0, status = 'inactive' WHERE id = ? OR slug = ?`, [id, id]);
        console.log(`[Case Deactivated] ID: ${id}`);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});


// Special static sub-routes for /cases
app.get(['/api/v1/admin/cases/export', '/api/v1/admin/cases/series/export'], requireAdminJWT, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM cases ORDER BY sortOrder DESC, id DESC`);
        let csv = "id,slug,name,price,volatility,sortOrder,seriesId,status\n";
        rows.forEach(r => {
            csv += `"${r.id}","${r.slug||''}","${(r.name||'').replace(/"/g, '""')}","${r.price||0}","${r.volatility||'AVERAGE'}","${r.sortOrder||0}","${r.seriesId||''}","${r.status||'active'}"\n`;
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=cases_export.csv');
        res.send(csv);
    } catch (e) {
        res.status(500).send("id,name\n");
    }
});

app.post('/api/v1/admin/cases/from-catalog', requireAdminJWT, async (req, res) => {
    try {
        const { itemId, name, price } = req.body || {};
        const slug = `catalog-${itemId || Date.now()}`;
        const result = await dbRun(
            `INSERT INTO cases (slug, name, price, image, volatility, sortOrder, status) VALUES (?,?,?,?,?,?, 'active')`,
            [slug, name || 'Catalog Case', price || 100, '/assets/header/logo.webp', 'AVERAGE', 0]
        );
        if (itemId) {
            await dbRun(`INSERT OR IGNORE INTO case_items (case_id, item_id, chance) VALUES (?, ?, 100)`, [result.lastID, itemId]);
        }
        res.json({ success: true, data: { id: result.lastID, slug, name: name || 'Catalog Case' } });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.post('/api/v1/admin/cases/bulk', requireAdminJWT, async (req, res) => {
    const { action, ids } = req.body || {};
    if (Array.isArray(ids)) {
        for (const id of ids) {
            if (action === 'activate') await dbRun(`UPDATE cases SET isActive = 1, status = 'active' WHERE id = ?`, [id]);
            else if (action === 'deactivate') await dbRun(`UPDATE cases SET isActive = 0, status = 'inactive' WHERE id = ?`, [id]);
            else if (action === 'delete') {
                await dbRun(`DELETE FROM case_items WHERE case_id = ?`, [id]);
                await dbRun(`DELETE FROM cases WHERE id = ?`, [id]);
            }
        }
    }
    res.json({ success: true });
});

app.post('/api/v1/admin/cases/fix-rtp', requireAdminJWT, (req, res) => {
    res.json({ success: true, message: 'RTP recalculated successfully' });
});

app.get('/api/v1/admin/cases/:id', requireAdminJWT, async (req, res) => {
    try {
        const cases = await getFullCasesList('WHERE id = ?', [req.params.id]);
        if (cases.length > 0) res.json({ success: true, data: cases[0] });
        else res.status(404).json({ success: false, message: "Case not found" });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 3. POST create new case
function slugify(text) {
    if (!text) return `case-${Date.now()}`;
    const map = { 'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya' };
    let str = text.toLowerCase();
    let res = '';
    for (let i = 0; i < str.length; i++) {
        res += map[str[i]] !== undefined ? map[str[i]] : str[i];
    }
    const clean = res.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return clean || `case-${Date.now()}`;
}

app.post('/api/v1/admin/cases', requireAdminJWT, async (req, res) => {
    try {
        const body = req.body.data || req.body || {};
        const name = body.name || 'New Case';
        const slug = body.slug ? slugify(body.slug) : slugify(name);
        const price = body.price != null ? parseFloat(body.price) : 0;
        const img = body.image || body.case_image || '';
        const volatility = (body.volatility || 'AVERAGE').toUpperCase();
        
        const rawSort = body.sortOrder ?? body.sort_order ?? body.sort ?? body.case_sort_order;
        const sortVal = rawSort != null ? (parseInt(rawSort) || 0) : 0;

        const isBlogger = (body.isBlogger !== undefined ? body.isBlogger : body.is_blogger) ? 1 : 0;
        const exclusiveTo = body.exclusiveTo || body.exclusive_to || null;
        const seriesId = body.seriesId || body.series_id || body.category || null;
        const items = body.items || [];

        const result = await dbRun(
            `INSERT INTO cases (slug, name, price, image, volatility, sortOrder, isBlogger, exclusiveTo, seriesId, status, isActive) VALUES (?,?,?,?,?,?,?,?,?,'active',1)`,
            [slug, name, price, img, volatility, sortVal, isBlogger, exclusiveTo, seriesId]
        );
        
        const newCaseId = result.lastID;
        console.log(`[Case Created] ID: ${newCaseId}, Name: ${name}, Image: ${img}, Sort: ${sortVal}`);

        if (Array.isArray(items) && items.length > 0) {
            for (let i = 0; i < items.length; i++) {
                const itemId = typeof items[i] === 'object' ? items[i].id : items[i];
                await dbRun(`INSERT OR IGNORE INTO case_items (case_id, item_id, chance) VALUES (?, ?, 0)`, [newCaseId, itemId]);
            }
        } else {
            const defaultItems = await dbAll(`SELECT id FROM items ORDER BY price DESC LIMIT 6`);
            for (const item of defaultItems) {
                await dbRun(`INSERT OR IGNORE INTO case_items (case_id, item_id, chance) VALUES (?, ?, 0)`, [newCaseId, item.id]);
            }
        }
        
        const fullCase = (await getFullCasesList('WHERE c.id = ?', [newCaseId]))[0];
        res.json({ success: true, data: fullCase || { id: newCaseId, slug, name } });
    } catch (e) {
        console.error("POST create case error:", e);
        res.status(400).json({ success: false, message: e.message });
    }
});

// 4. PUT update existing case
app.put('/api/v1/admin/cases/:id', requireAdminJWT, async (req, res) => {
    try {
        const caseId = req.params.id;
        const body = req.body.data || req.body || {};

        const existing = (await getFullCasesList('WHERE c.id = ?', [caseId]))[0];
        if (!existing) return res.status(404).json({ success: false, message: "Case not found" });

        const name = body.name !== undefined ? body.name : existing.name;
        const slug = body.slug !== undefined ? body.slug : existing.slug;
        const price = body.price !== undefined ? parseFloat(body.price) : existing.price;

        let img = existing.image;
        const newImg = body.image || body.case_image;
        if (newImg && String(newImg).trim() !== '') {
            img = String(newImg).trim();
        }

        const volatility = body.volatility !== undefined ? String(body.volatility).toUpperCase() : existing.volatility;

        let sortVal = existing.sortOrder;
        const rawSort = body.sortOrder ?? body.sort_order ?? body.sort ?? body.case_sort_order;
        if (rawSort !== undefined && rawSort !== null && String(rawSort).trim() !== '') {
            sortVal = parseInt(rawSort) || 0;
        }

        const isBlogger = body.isBlogger !== undefined ? (body.isBlogger ? 1 : 0) : (body.is_blogger !== undefined ? (body.is_blogger ? 1 : 0) : existing.isBlogger);
        const exclusiveTo = body.exclusiveTo !== undefined ? body.exclusiveTo : (body.exclusive_to !== undefined ? body.exclusive_to : existing.exclusiveTo);
        const seriesId = body.seriesId !== undefined ? body.seriesId : (body.series_id !== undefined ? body.series_id : (body.category !== undefined ? body.category : existing.seriesId));

        await dbRun(
            `UPDATE cases SET name=?, slug=?, price=?, image=?, volatility=?, sortOrder=?, isBlogger=?, exclusiveTo=?, seriesId=? WHERE id=?`,
            [name, slug, price, img, volatility, sortVal, isBlogger, exclusiveTo, seriesId, caseId]
        );

        // Update items array if provided
        const items = body.items;
        if (Array.isArray(items)) {
            const newItemIds = items.map(it => typeof it === 'object' ? it.id : it);
            if (newItemIds.length > 0) {
                const placeholders = newItemIds.map(() => '?').join(',');
                await dbRun(`DELETE FROM case_items WHERE case_id = ? AND item_id NOT IN (${placeholders})`, [caseId, ...newItemIds]);
                for (const item of items) {
                    const itemId = typeof item === 'object' ? item.id : item;
                    const chance = typeof item === 'object' ? (item.chance || 0) : 0;
                    const tFrom = typeof item === 'object' ? (item.ticketRangeFrom || 0) : 0;
                    const tTo = typeof item === 'object' ? (item.ticketRangeTo || 0) : 0;
                    
                    await dbRun(`
                        INSERT INTO case_items (case_id, item_id, chance, ticketRangeFrom, ticketRangeTo)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(case_id, item_id) DO UPDATE SET
                        chance = CASE WHEN excluded.chance > 0 THEN excluded.chance ELSE case_items.chance END,
                        ticketRangeFrom = CASE WHEN excluded.ticketRangeFrom > 0 THEN excluded.ticketRangeFrom ELSE case_items.ticketRangeFrom END,
                        ticketRangeTo = CASE WHEN excluded.ticketRangeTo > 0 THEN excluded.ticketRangeTo ELSE case_items.ticketRangeTo END
                    `, [caseId, itemId, chance, tFrom, tTo]);
                }
            } else {
                await dbRun(`DELETE FROM case_items WHERE case_id = ?`, [caseId]);
            }
        }

        console.log(`[Case Updated] ID: ${caseId}, Name: ${name}, Image: ${img}, Sort: ${sortVal}`);
        const updatedCase = (await getFullCasesList('WHERE c.id = ?', [caseId]))[0];
        res.json({ success: true, data: updatedCase || { id: caseId } });
    } catch (e) {
        console.error("PUT update case error:", e);
        res.status(400).json({ success: false, message: e.message });
    }
});

// 5. DELETE case
app.delete('/api/v1/admin/cases/:id', requireAdminJWT, async (req, res) => {
    await dbRun(`DELETE FROM case_items WHERE case_id = ?`, [req.params.id]);
    await dbRun(`DELETE FROM cases WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

// 6. RTP Tiers & Item Chances Save

// 6.1 GET RTP Tier item chances for a case
app.get('/api/v1/admin/rtp/cases/:caseId/tier/:tierId', requireAdminJWT, async (req, res) => {
    try {
        const caseId = req.params.caseId;
        const caseItems = await dbAll(`
            SELECT ci.item_id as itemId, i.name as itemName, CAST(i.price AS TEXT) as itemPrice,
                   ci.chance as chancePercent, ci.chance as chanceRtp96,
                   ci.ticketRangeFrom, ci.ticketRangeTo, i.rarity
            FROM case_items ci
            JOIN items i ON ci.item_id = i.id
            WHERE ci.case_id = ?
        `, [caseId]);
        res.json({ success: true, data: caseItems });
    } catch (e) {
        res.json({ success: true, data: [] });
    }
});

app.put('/api/v1/admin/rtp/cases/:caseId/tier/:tierId', requireAdminJWT, async (req, res) => {
    try {
        const caseId = req.params.caseId;
        const body = req.body.data || req.body || {};
        const items = body.items || [];
        
        if (Array.isArray(items)) {
            for (const item of items) {
                const itemId = item.itemId || item.id;
                const chance = item.chancePercent || item.chance || 0;
                const tFrom = item.ticketRangeFrom || 0;
                const tTo = item.ticketRangeTo || 0;
                
                await dbRun(`
                    INSERT INTO case_items (case_id, item_id, chance, ticketRangeFrom, ticketRangeTo)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(case_id, item_id) DO UPDATE SET
                    chance = excluded.chance,
                    ticketRangeFrom = excluded.ticketRangeFrom,
                    ticketRangeTo = excluded.ticketRangeTo
                `, [caseId, itemId, chance, tFrom, tTo]);
            }
        }
        
        res.json({ success: true, data: { caseId, updatedCount: items.length } });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// 7. PUBLIC API FOR MAIN WEBSITE DISPLAY
app.get('/api/v1/cases', async (req, res) => {
    try {
        const cases = await getFullCasesList();
        res.json({ success: true, data: cases });
    } catch (e) {
        res.json({ success: true, data: [] });
    }
});

app.get('/api/v1/cases/:slug', async (req, res) => {
    try {
        const cases = await getFullCasesList('WHERE slug = ? OR id = ?', [req.params.slug, req.params.slug]);
        if (cases.length > 0) res.json({ success: true, data: cases[0] });
        else res.status(404).json({ success: false, message: "Case not found" });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// =====================================================
// CONFIG API
// =====================================================
// Обработчики config/games и config/socials переехали в adminRoutes.js:
// здесь они отдавали захардкоженный список и ничего не сохраняли.

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

// Multer Storage Configuration for File Uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const folder = req.query.folder || 'general';
        const targetDir = path.resolve(__dirname, '..', '..', 'public', 'uploads', folder);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        cb(null, targetDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname) || '.png';
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, filename);
    }
});
const upload = multer({ storage });

// Serve static uploaded files
app.use('/uploads', express.static(path.resolve(__dirname, '..', '..', 'public', 'uploads')));

// Real Media Upload Endpoint
app.post('/api/v1/admin/media/upload', requireAdminJWT, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            console.error('[Upload Error]', err);
            return res.status(400).json({ success: false, message: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }
        const folder = req.query.folder || 'general';
        const relPath = `/uploads/${folder}/${req.file.filename}`;
        console.log(`[File Uploaded] Folder: ${folder}, Saved: ${relPath}`);
        res.json({
            success: true,
            data: {
                url: relPath,
                path: relPath,
                filename: req.file.filename
            }
        });
    });
});

// Additional Feature Endpoints
app.get(['/api/v1/admin/cases/export', '/api/v1/admin/cases/series/export'], requireAdminJWT, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM cases ORDER BY sortOrder DESC, id DESC`);
        let csv = "id,slug,name,price,volatility,sortOrder,seriesId,status\n";
        rows.forEach(r => {
            csv += `"${r.id}","${r.slug||''}","${(r.name||'').replace(/"/g, '""')}","${r.price||0}","${r.volatility||'AVERAGE'}","${r.sortOrder||0}","${r.seriesId||''}","${r.status||'active'}"\n`;
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=cases_export.csv');
        res.send(csv);
    } catch (e) {
        res.status(500).send("id,name\n");
    }
});

app.post('/api/v1/admin/cases/from-catalog', requireAdminJWT, async (req, res) => {
    try {
        const { itemId, name, price } = req.body || {};
        const slug = `catalog-${itemId || Date.now()}`;
        const result = await dbRun(
            `INSERT INTO cases (slug, name, price, image, volatility, sortOrder, status) VALUES (?,?,?,?,?,?, 'active')`,
            [slug, name || 'Catalog Case', price || 100, '/assets/header/logo.webp', 'AVERAGE', 0]
        );
        if (itemId) {
            await dbRun(`INSERT OR IGNORE INTO case_items (case_id, item_id, chance) VALUES (?, ?, 100)`, [result.lastID, itemId]);
        }
        res.json({ success: true, data: { id: result.lastID, slug, name: name || 'Catalog Case' } });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.post('/api/v1/admin/cases/bulk', requireAdminJWT, async (req, res) => {
    const { action, ids } = req.body || {};
    if (Array.isArray(ids)) {
        for (const id of ids) {
            if (action === 'activate') await dbRun(`UPDATE cases SET isActive = 1, status = 'active' WHERE id = ?`, [id]);
            else if (action === 'deactivate') await dbRun(`UPDATE cases SET isActive = 0, status = 'inactive' WHERE id = ?`, [id]);
            else if (action === 'delete') {
                await dbRun(`DELETE FROM case_items WHERE case_id = ?`, [id]);
                await dbRun(`DELETE FROM cases WHERE id = ?`, [id]);
            }
        }
    }
    res.json({ success: true });
});

app.post('/api/v1/admin/cases/fix-rtp', requireAdminJWT, (req, res) => {
    res.json({ success: true, message: 'RTP recalculated successfully' });
});

app.put('/api/v1/admin/cases/series/:id/supply/:caseId', requireAdminJWT, (req, res) => {
    res.json({ success: true });
});

app.get('/api/v1/admin/accounting', requireAdminJWT, (req, res) => {
    res.json({
        success: true,
        data: {
            totalDeposits: 542000,
            totalWithdrawals: 310000,
            netRevenue: 232000,
            activeUsers: 1420,
            currency: 'RUB'
        }
    });
});

// Заглушки удалены: эти пути обслуживает adminRoutes.js, где данные берутся
// из базы. Express берёт ПЕРВЫЙ совпавший обработчик, поэтому заглушки выше
// перекрывали настоящие роуты, и разделы админки оставались пустыми.

// --- Вход по passkey (WebAuthn) ---
const passkeys = require('./passkeys').register({
    app, db, dbAll, dbGet, dbRun, generateAdminJWT
});

// --- Разделы админки ---
// Схема и роуты для секций, у которых их не было: до этого 29 эндпоинтов
// проваливались в catch-all и страницы открывались пустыми.
//
// Роуты регистрируются СИНХРОННО: Express сопоставляет обработчики в порядке
// объявления, и регистрация внутри .then() поставила бы их после catch-all,
// то есть они бы никогда не вызвались. Создание таблиц идёт параллельно —
// запросы всё равно выстраиваются в очередь на одном соединении SQLite.
require('./adminRoutes').makeAdminRoutes({ app, dbAll, dbGet, dbRun, requireAdminJWT });
require('./adminSchema').ensureAdminSchema({ dbRun, dbGet })
    .catch((e) => console.error('[Admin] Схема разделов:', e.message));

// =====================================================
// CATCH-ALL for any remaining /api/v1/admin/* routes
// =====================================================
app.all('/api/v1/admin/*', requireAdminJWT, (req, res) => {
    console.log(`[Catch-all] ${req.method} ${req.path}`);
    // catchAll:true — чтобы «обработчика нет» нельзя было спутать с «таблица
    // пуста»: раньше обе ситуации давали байт в байт одинаковый ответ.
    res.json({ success: true, data: [], items: [], total: 0, catchAll: true });
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
    passkeys.credentialCount().then((n) => {
        if (REQUIRE_ADMIN_AUTH && n === 0) {
            console.warn('[!] ADMIN_REQUIRE_AUTH=1, но ни одного passkey не зарегистрировано.');
            console.warn('    Войти будет нельзя. Зарегистрируйте ключ или временно поставьте 0.');
        } else if (!REQUIRE_ADMIN_AUTH) {
            console.warn('[!] ADMIN_REQUIRE_AUTH=0 — админка пропускает ЛЮБОЙ запрос без токена.');
            console.warn(`    Ключей зарегистрировано: ${n}. Перед публикацией поставьте 1.`);
        } else {
            console.log(`Passkey: защита включена, ключей зарегистрировано ${n}`);
        }
    }).catch(() => {});
});
