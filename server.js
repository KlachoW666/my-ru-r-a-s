// Читаем .env из корня проекта (встроено в Node >= 20.12, никаких зависимостей).
// Должно стоять до любых require, которые читают process.env.
try { process.loadEnvFile(require('path').resolve(__dirname, '.env')); } catch { /* .env необязателен */ }

function fixImageUrl(img) {
  if (!img) return "/assets/battles/winner-boar.png";
  if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('/')) {
    if (img.includes('community.steamstatic.com')) {
      return img.replace('community.steamstatic.com', 'community.cloudflare.steamstatic.com');
    }
    return img;
  }
  if (img.startsWith('-9a81dl')) {
    return `https://community.cloudflare.steamstatic.com/economy/image/${img}`;
  }
  return img;
}
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { SKINS_FILE, ADMIN_DB_PATH } = require('./services/steamSync');
const { registerAuthRoutes, attachAuth, currentUser, guestUser, verifyJWT, ensureAuthSchema, PUBLIC_URL, ALLOW_MOCK_AUTH, ALLOWED_ORIGINS } = require('./services/auth');
const {
  startWorker: startCatalogWorker,
  stopWorker: stopCatalogWorker,
  getStatus: getCatalogStatus,
  queryItems,
  getRarityBreakdown,
  ensureCatalogSchema,
  openDb: openCatalogDb,
  PAGE_SIZE: CATALOG_PAGE_SIZE,
  REQUEST_INTERVAL_MS: CATALOG_INTERVAL_MS
} = require('./services/steamCatalog');
const {
  buildDistribution, rollOne, pickByRoll, newServerSeed, chancesForDisplay, fairFloat, DEFAULT_RTP
} = require('./services/drops');
const { cleanDanglingCaseItems, getCaseHealth, getBrokenCases, MAX_RTP } = require('./services/caseHealth');
const { verifyMailer } = require('./services/mailer');
const { makeBattlesService } = require('./services/battles');
const { makeGiveawaysService } = require('./services/giveaways');
const { makeInventoryService } = require('./services/inventory');
const { makeFairnessService } = require('./services/fairness');

// --- Баланс ------------------------------------------------------------------
// Авторизованному пишем в users.balance, гостю — в mockUser (в памяти).
// Это убирает прежнее поведение, когда баланс жил только в памяти процесса и
// сбрасывался при каждом рестарте.

async function getBalance(req, mockUser) {
  if (req.auth && !req.auth.mock) {
    const rows = await queryAdminDb(`SELECT balance FROM users WHERE id = ?`, [req.auth.sub]);
    if (rows.length) return Number(rows[0].balance) || 0;
  }
  return Number(mockUser.balance) || 0;
}

/**
 * История операций. Таблицы transactions в схеме админки не было — создаём
 * идемпотентно, как ensureAuthSchema. Гостевые операции не пишем: у гостя нет
 * строки в users, и привязать их не к чему.
 */
let txSchemaReady = false;
async function ensureTxSchema() {
  if (txSchemaReady) return;
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT,
      amount REAL,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, () => {
      db.run(`CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at)`, () => {
        db.close(); resolve();
      });
    });
  });
  txSchemaReady = true;
}

async function recordTransaction(req, type, amount, comment = '') {
  if (!req.auth || req.auth.mock) return;
  await ensureTxSchema();
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`INSERT INTO transactions (user_id, type, amount, comment) VALUES (?, ?, ?, ?)`,
      [req.auth.sub, type, amount, comment], () => { db.close(); resolve(); });
  });
}

/** Меняет баланс на delta. min — нижняя граница, ниже которой списание не идёт. */
async function adjustBalance(req, mockUser, delta) {
  const current = await getBalance(req, mockUser);
  const next = Math.max(0, +(current + delta).toFixed(2));
  if (req.auth && !req.auth.mock) {
    await new Promise((resolve) => {
      const db = getAdminDb();
      if (!db) return resolve();
      db.run(`UPDATE users SET balance = ? WHERE id = ?`, [next, req.auth.sub], () => { db.close(); resolve(); });
    });
  } else {
    mockUser.balance = next;
  }
  return next;
}

// --- Настройки из админки ---------------------------------------------------
// Игровой сервер читает те же таблицы, что правит админка. До этого режимы
// игр, соцсети и методы оплаты были захардкожены в этом файле: правки в
// админке на сайт не попадали вообще.

async function adminSetting(key, fallback = {}) {
  const rows = await queryAdminDb(`SELECT value FROM app_settings WHERE key = ?`, [key]);
  if (!rows.length) return fallback;
  try { return JSON.parse(rows[0].value); } catch { return fallback; }
}

// --- Кэш ответов в памяти -------------------------------------------------
// Сайт читает каталог из SQLite, а не из Steam, поэтому единственное, что тут
// нужно, — не дёргать базу на каждый запрос. TTL 30 с: именно с такой частотой
// пользователь и видит обновления.
const _cache = new Map();
async function cached(key, ttlMs, producer) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await producer();
  _cache.set(key, { at: Date.now(), value });
  if (_cache.size > 500) {                       // простая защита от разрастания
    const oldest = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
  return value;
}

const app = express();
const PORT = process.env.PORT || 3101;

// Path to public static directory
const PUBLIC_DIR = path.resolve(__dirname, 'public');

// За nginx/Cloudflare: без этого req.ip — адрес прокси, а не посетителя,
// и req.protocol всегда 'http'.
//
// На флаг Secure у refresh-cookie это НЕ влияет: он берётся из NODE_ENV
// (см. cookieOptions в services/auth.js), а не из X-Forwarded-Proto.
app.set('trust proxy', 1);

// origin:true отражает Origin запроса вместо '*' — обязательно, потому что
// фронт ходит с withCredentials:true, а с '*' браузер такие ответы отбрасывает.
//
// Но на боевом домене отражать вообще любой Origin нельзя: сайт с чужого
// адреса получал бы кредитные ответы нашего API. В production отражаем только
// свои домены (titanrust.ru, www, admin.titanrust.ru + ALLOWED_ORIGINS),
// в разработке оставляем как было, иначе локальные порты перестанут ходить.
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);              // curl, серверные запросы
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    const clean = origin.replace(/\/+$/, '');
    if (ALLOWED_ORIGINS.has(clean)) return cb(null, true);
    console.warn(`[CORS] отклонён origin: ${origin}`);
    return cb(null, false);
  },
  credentials: true
}));
app.use(express.json());

// Разбор Bearer-токена ДО объявления всех роутов.
// Express применяет middleware только к тому, что объявлено ПОСЛЕ него, а
// registerAuthRoutes вызывается ниже игровых роутов — из-за этого /cases/open,
// апгрейдер, баттлы и инвентарь не видели req.auth и работали как гость:
// предметы падали в инвентарь с пустым user_id, транзакции не писались.
app.use(attachAuth);

// Request logging middleware for API calls
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[API] ${req.method} ${req.path}`);
  }
  next();
});

// --- HELPER DATABASE FUNCTIONS (Synchronized with admin.titanrust.ru) ---

function getAdminDb() {
  if (fs.existsSync(ADMIN_DB_PATH)) {
    const sqlite3 = require(path.join(__dirname, 'admin.titanrust.ru', 'server', 'node_modules', 'sqlite3')).verbose();
    return new sqlite3.Database(ADMIN_DB_PATH);
  }
  return null;
}

function queryAdminDb(sql, params = []) {
  return new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve([]);
    db.all(sql, params, (err, rows) => {
      db.close();
      if (err) resolve([]);
      else resolve(rows || []);
    });
  });
}

// Get live items from Admin DB or fallback
// Кэшируется на 30 с: каталог вырос до тысяч строк, а функция дёргается почти
// из каждого игрового эндпоинта. Снятые с продажи предметы не отдаём.
async function getLiveItems() {
  return cached('liveItems', 30000, _getLiveItemsUncached);
}

async function _getLiveItemsUncached() {
  let rows = await queryAdminDb(`SELECT * FROM items WHERE delisted = 0 ORDER BY price DESC`);
  // Колонки delisted может ещё не быть — до первой миграции каталога.
  if (!rows || rows.length === 0) {
    rows = await queryAdminDb(`SELECT * FROM items ORDER BY price DESC`);
  }
  if (rows && rows.length > 0) {
    return rows.map(r => ({
      id: `db-${r.id}`,
      name: r.name || r.market_hash_name,
      marketHashName: r.market_hash_name,
      price: r.price || 100,
      priceText: `${r.price || 100} ₽`,
      image: fixImageUrl(r.image),
      rarity: (r.rarity || "rare").toLowerCase(),
      colorHex: r.color ? `#${r.color}` : "#35a3f1",
      upgraderEnabled: r.upgraderEnabled === 1
    }));
  }
  
  // Fallback to local skins.json
  if (fs.existsSync(SKINS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SKINS_FILE, 'utf8'));
      if (data.skins && data.skins.length > 0) return data.skins;
    } catch (e) {}
  }

  return [
    { id: "1", name: "AK-47 | Tempered", price: 4500, priceText: "4500 ₽", image: "/assets/battles/winner-boar.png", rarity: "mythic" },
    { id: "2", name: "LR-300 | Victoria", price: 1200, priceText: "1200 ₽", image: "/assets/battles/boar-ready.png", rarity: "legendary" },
    { id: "3", name: "MP5 | Cold Hunter", price: 350, priceText: "350 ₽", image: "/assets/header/logo.webp", rarity: "rare" }
  ];
}

// Get live series / categories from Admin DB with non-empty cases filtering
async function getLiveSeries() {
  const dbSeries = await queryAdminDb(`SELECT * FROM series WHERE status = 'active' ORDER BY id ASC`);
  const dbCases = await queryAdminDb(`SELECT * FROM cases WHERE archived = 0 ORDER BY sortOrder ASC`);
  const items = await getLiveItems();

  // Helper to format case object for Vue frontend
  const formatCase = (c) => {
    const sId = c.seriesId ? parseInt(c.seriesId, 10) : (c.series_id ? parseInt(c.series_id, 10) : 1);
    let img = c.image;
    if (!img || img === "" || img === "/assets/header/logo.webp") {
      img = "/uploads/cases/1786522990114-495918520.webp";
    }
    return {
      id: c.slug || `case-${c.id}`,
      slug: c.slug || `case-${c.id}`,
      name: c.name || "Кейс",
      category: c.category || "standard",
      price: c.price || 49,
      oldPrice: Math.round((c.price || 49) * 1.5),
      image: img,
      volatility: c.volatility || "AVERAGE",
      isBlogger: c.isBlogger === 1,
      seriesId: sId,
      items: items.slice(0, 10)
    };
  };

  const allFormattedCases = dbCases.map(formatCase);
  const seriesList = [];
  const assignedSlugs = new Set();

  if (dbSeries && dbSeries.length > 0) {
    for (const s of dbSeries) {
      const sCases = allFormattedCases.filter(c => c.seriesId === s.id);
      if (sCases.length > 0) {
        sCases.forEach(c => assignedSlugs.add(c.slug));
        seriesList.push({
          id: s.id,
          name: s.name || `Категория #${s.id}`,
          description: s.description || "",
          image: s.image || s.titleImage || "/uploads/series/1786522945847-911377162.webp",
          titleImage: s.titleImage || s.image || "/uploads/series/1786522945847-911377162.webp",
          sortOrder: s.sortOrder || s.position || 0,
          isActive: true,
          isLimited: s.isLimited === 1,
          isSecret: s.isSecret === 1,
          cases: sCases
        });
      }
    }
  }

  // Handle any remaining unassigned cases
  const unassignedCases = allFormattedCases.filter(c => !assignedSlugs.has(c.slug));
  if (unassignedCases.length > 0) {
    seriesList.unshift({
      id: 1,
      name: "Популярные Кейсы",
      description: "",
      sortOrder: 0,
      isActive: true,
      cases: unassignedCases
    });
  }

  // If no series and no cases exist in DB, fallback to default mock series
  if (seriesList.length === 0) {
    return [
      {
        id: 1,
        name: "Популярные Кейсы",
        description: "",
        sortOrder: 0,
        isActive: true,
        cases: [
          {
            id: "rust-starter",
            slug: "rust-starter",
            name: "Халявный Кабан",
            category: "Популярные",
            price: 49,
            oldPrice: 99,
            image: "/assets/header/logo.webp",
            volatility: "AVERAGE",
            isBlogger: false,
            seriesId: 1,
            items: items.slice(0, 5)
          },
          {
            id: "weapon-set",
            slug: "weapon-set",
            name: "Оружейный Сет",
            category: "Rust Базовые",
            price: 199,
            oldPrice: 299,
            image: "/assets/header/logo.webp",
            volatility: "AVERAGE",
            isBlogger: false,
            seriesId: 1,
            items: items.slice(2, 8)
          }
        ]
      }
    ];
  }

  return seriesList;
}

// Get all live cases flat list
async function getLiveCases() {
  const series = await getLiveSeries();
  const cases = series.flatMap(s => s.cases);
  
  // Deduplicate by slug
  const uniqueMap = new Map();
  cases.forEach(c => uniqueMap.set(c.slug, c));
  return Array.from(uniqueMap.values());
}

// Get live banners from Admin DB or fallback
async function getLiveBanners() {
  const dbBanners = await queryAdminDb(`SELECT * FROM banners WHERE active = 1 ORDER BY position ASC`);
  if (dbBanners && dbBanners.length > 0) {
    return dbBanners.map(b => ({
      id: `banner-${b.id}`,
      title: b.title || "Делай нарезки\nлутай ещё больше",
      description: "Конкурс моментов в тиктоке",
      buttonText: "Участвовать",
      buttonColor: "#e54b38",
      buttonAction: "url",
      buttonValue: b.url || "/giveaway",
      glowColor: "#84c424",
      borderColor: "#4d7318",
      background: "radial-gradient(ellipse at 80% 50%, #2e4a0d 0%, #0d1405 100%)",
      image: b.image || "/assets/battles/winner-boar.png",
      video: "/assets/raffle/mega-loop.mp4"
    }));
  }

  return [
    {
      id: "banner-tiktok",
      title: "Делай нарезки\nлутай ещё больше",
      description: "Конкурс моментов в тиктоке",
      buttonText: "Участвовать",
      buttonColor: "#e54b38",
      buttonAction: "url",
      buttonValue: "/giveaway",
      glowColor: "#84c424",
      borderColor: "#4d7318",
      background: "radial-gradient(ellipse at 80% 50%, #2e4a0d 0%, #0d1405 100%)",
      image: "/assets/battles/winner-boar.png",
      video: "/assets/raffle/mega-loop.mp4"
    },
    {
      id: "banner-battles",
      title: "Кейс-Баттлы\nKaban.gg",
      description: "Замесы 1v1, 2v2 и 4v4",
      buttonText: "Играть",
      buttonColor: "#84c424",
      buttonAction: "url",
      buttonValue: "/crate-pvp",
      glowColor: "#84c424",
      borderColor: "#4d7318",
      background: "radial-gradient(ellipse at 80% 50%, #2e4a0d 0%, #0d1405 100%)",
      image: "/assets/battles/boar-ready.png",
      video: "/assets/raffle/mega-loop.webm"
    }
  ];
}

// --- MOCK USER & CONFIG ---
const mockAvatar = "/avatars/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg";

const mockConfig = {
  modes: [
    { name: "case_opening", enabled: true },
    { name: "battle", enabled: true },
    { name: "upgrade", enabled: true },
    { name: "deposit_chain", enabled: true },
    { name: "online_badge", enabled: true }
  ],
  topDropsVisible: true,
  isMaintenance: false,
  audio: {
    click: "/audio/click.ogg",
    open: "/audio/open.mp3",
    win: "/audio/win.wav",
    spin: "/audio/spin.mp3",
    roulette: "/audio/roulette.ogg",
    battle: "/audio/battle.ogg",
    upgrade: "/audio/upgrade.mp3"
  }
};

let mockUser = {
  id: "76561198991234567",
  steamId: "76561198991234567",
  username: "Kaban_Pro",
  name: "Kaban_Pro",
  avatar: mockAvatar,
  avatarFull: mockAvatar,
  balance: 5420.50,
  currency: "RUB",
  status: "active",
  tradeLink: "https://steamcommunity.com/tradeoffer/new/?partner=12345678&token=abcDEF12",
  isUserAdmin: true,
  canAccessStreamerStatistics: true,
  createdAt: new Date().toISOString()
};

const mockStats = {
  onlineCount: 412,
  openedCasesCount: 128450,
  upgradesCount: 45120,
  battlesCount: 18920
};

// --- Баттлы и розыгрыши -----------------------------------------------------
// Оба сервиса держат состояние в SQLite: до этого списки были статичными
// моками в памяти, а create/join ничего не сохраняли.

/** Начисление по id пользователя — нужно розыгрышам, где нет объекта req. */
async function adjustBalanceById(userId, delta, txType, comment) {
  const rows = await queryAdminDb(`SELECT balance FROM users WHERE id = ?`, [userId]);
  if (!rows.length) return null;
  const next = Math.max(0, +((Number(rows[0].balance) || 0) + delta).toFixed(2));
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`UPDATE users SET balance = ? WHERE id = ?`, [next, userId], () => { db.close(); resolve(); });
  });
  if (txType) {
    await ensureTxSchema();
    await new Promise((resolve) => {
      const db = getAdminDb();
      if (!db) return resolve();
      db.run(`INSERT INTO transactions (user_id, type, amount, comment) VALUES (?, ?, ?, ?)`,
        [userId, txType, delta, comment || ''], () => { db.close(); resolve(); });
    });
  }
  return next;
}

/** Запись транзакции по id пользователя — нужна инвентарю, где нет req. */
async function recordTransactionById(userId, type, amount, comment) {
  await ensureTxSchema();
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`INSERT INTO transactions (user_id, type, amount, comment) VALUES (?, ?, ?, ?)`,
      [userId, type, amount, comment || ''], () => { db.close(); resolve(); });
  });
}

const inventory = makeInventoryService({
  queryAdminDb, getAdminDb, adjustBalanceById, recordTransactionById, fixImageUrl
});
const fairness = makeFairnessService({ queryAdminDb, getAdminDb });

const battles = makeBattlesService({
  queryAdminDb, getAdminDb, getCaseItemsFromDb, getFallbackItems, fixImageUrl
});
const giveaways = makeGiveawaysService({
  queryAdminDb, getAdminDb, queryItems, adjustBalanceById, fixImageUrl
});

// --- ЛЕНТА ДРОПОВ -----------------------------------------------------------
// Кольцевой буфер реальных выигрышей + синтетический наполнитель, чтобы лента
// не была пустой на старте. Реальные открытия кейсов попадают сюда из
// POST /cases/open и вытесняют синтетику.

const LIVE_FEED_MAX = 200;
const realDrops = [];              // самые свежие в начале

const FEED_NAMES = [
  'Кабан', 'RustLord', 'Шрам', 'Тихий', 'Барсук', 'Никита', 'Волк', 'Прапор',
  'Сталкер', 'Мясник', 'Хантер', 'Гоша', 'Рейдер', 'Пепел', 'Тайга'
];

function makeWin({ item, user, eventType = 'CASE', caseSlug = '', caseImage = null, betAmount = 0, multiplier = 1, wonAt }) {
  const value = Number(item.price) || 0;
  return {
    sourceEventId: `${eventType}-${wonAt}-${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id ?? 0,
    userName: user.name,
    avatarUrl: user.avatar || mockAvatar,
    steamLevel: user.steamLevel ?? 0,
    wonAt,
    eventType,
    itemName: item.name,
    itemImage: fixImageUrl(item.image),
    itemValue: value,
    betAmount,
    winAmount: value,
    multiplier,
    isBigWin: value >= 5000,
    caseImage,
    caseSlug,
    itemColor: item.colorHex || item.color || null,
    itemRarity: mapRarity(item.rarity)
  };
}

/** Реальный выигрыш — вызывается при открытии кейса. */
function pushLiveDrop(win) {
  realDrops.unshift(win);
  if (realDrops.length > LIVE_FEED_MAX) realDrops.length = LIVE_FEED_MAX;
}

// Синтетика пересобирается раз в 30 с, поэтому лента выглядит живой даже
// без игроков. Веса подобраны так, чтобы дорогие предметы падали редко.
let syntheticFeed = [];
let syntheticAt = 0;

async function buildSyntheticFeed() {
  const items = await getLiveItems();
  if (!items.length) return [];
  const cheap = items.filter(i => i.price < 1000);
  const mid = items.filter(i => i.price >= 1000 && i.price < 10000);
  const rich = items.filter(i => i.price >= 10000);
  const pick = () => {
    const r = Math.random();
    const pool = r < 0.75 ? cheap : r < 0.96 ? mid : rich;
    const src = pool.length ? pool : items;
    return src[Math.floor(Math.random() * src.length)];
  };

  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (let i = 0; i < LIVE_FEED_MAX; i++) {
    const item = pick();
    out.push(makeWin({
      item,
      user: { id: 1000 + i, name: FEED_NAMES[i % FEED_NAMES.length] + (i % 7 ? '' : '_' + (10 + i)), avatar: mockAvatar, steamLevel: (i * 7) % 60 },
      eventType: i % 9 === 0 ? 'UPGRADER' : i % 5 === 0 ? 'BATTLE' : 'CASE',
      betAmount: Math.round(item.price * (0.4 + Math.random() * 0.5)),
      multiplier: 1,
      wonAt: now - i * 11
    }));
  }
  return out;
}

async function getLiveFeed(mode, limit) {
  if (Date.now() - syntheticAt > 30000 || !syntheticFeed.length) {
    syntheticFeed = await buildSyntheticFeed();
    syntheticAt = Date.now();
  }
  const all = [...realDrops, ...syntheticFeed];
  if (mode === 'top' || mode === 'bigwins') {
    return [...all].sort((a, b) => b.itemValue - a.itemValue).slice(0, limit);
  }
  return all.slice(0, limit);   // live — по свежести
}

// --- STEAM SYNC ADMIN & PUBLIC ENDPOINTS ---

// Ручной запуск/остановка фонового обхода каталога.
app.post(['/api/v1/admin/sync-skins', '/api/v1/skins/sync'], async (req, res) => {
  try {
    if (req.body?.action === 'stop') {
      stopCatalogWorker();
      return res.json({ status: "success", message: "Обход каталога остановлен", data: getCatalogStatus() });
    }
    const st = getCatalogStatus();
    if (st.running) {
      return res.json({
        status: "success",
        message: `Обход уже идёт: ${st.offset} из ${st.totalCount || '?'}`,
        data: st
      });
    }
    startCatalogWorker();
    res.json({ status: "success", message: "Обход каталога запущен", data: getCatalogStatus() });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Целостность кейсов: какие настроены неверно и почему.
app.get(['/api/v1/admin/cases/health', '/api/v1/cases/health'], async (req, res) => {
  const health = await getCaseHealth();
  res.json({
    status: "success",
    data: {
      total: health.length,
      broken: health.filter(c => !c.ok).length,
      maxRtp: MAX_RTP,
      cases: health
    }
  });
});

// Прогресс синхронизации — для админки и для проверки руками.
app.get(['/api/v1/skins/status', '/api/v1/admin/sync-skins/status'], (req, res) => {
  const st = getCatalogStatus();
  res.json({
    status: "success",
    data: {
      ...st,
      etaHuman: st.etaMs != null ? `${Math.round(st.etaMs / 60000)} мин` : null,
      progressPercent: st.totalCount ? +((st.offset / st.totalCount) * 100).toFixed(1) : 0
    }
  });
});

// Сводка по редкостям (кэш 30 с).
app.get('/api/v1/skins/rarities', async (req, res) => {
  res.json({ status: "success", data: await cached('rarities', 30000, getRarityBreakdown) });
});

// Каталог предметов: фильтры + постраничная выдача, кэш 30 с.
// Отдаём из SQLite, в Steam на запрос пользователя не ходим никогда.
app.get('/api/v1/skins', async (req, res) => {
  const { rarity, minPrice, maxPrice, search } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const key = `skins:${rarity || ''}:${minPrice || ''}:${maxPrice || ''}:${search || ''}:${limit}:${offset}`;

  const result = await cached(key, 30000, () => queryItems({
    rarity, minPrice, maxPrice, search, limit, offset
  }));

  res.json({
    status: "success",
    count: result.items.length,
    total: result.total,
    limit,
    offset,
    data: result.items
  });
});

// --- CASES & SERIES API ROUTES (Fully Synced with Vue 3 Frontend Schema) ---

app.get('/api/v1/cases/series', async (req, res) => {
  const seriesList = await getLiveSeries();
  res.json({ status: "success", data: { series: seriesList } });
});

app.get('/api/v1/cases', async (req, res) => {
  const cases = await getLiveCases();
  res.json({
    status: "success",
    data: {
      cases: cases,
      page: 1,
      limit: 100,
      total: cases.length
    }
  });
});

app.get('/api/v1/cases/limited/remaining', (req, res) => {
  res.json({ status: "success", data: { remaining: 50, supplyTotal: 100 } });
});

app.get('/api/v1/cases/secret/state', async (req, res) => {
  const secretSeries = await queryAdminDb(
    `SELECT id, name FROM series WHERE isSecret = 1 AND status = 'active'`);
  const slotsTotal = Number(process.env.SECRET_SLOTS || 24);
  let revealedCount = 0;
  if (secretSeries.length) {
    const row = await queryAdminDb(
      `SELECT COUNT(*) AS c FROM case_items ci
        JOIN cases ca ON ca.id = ci.case_id
        WHERE ca.seriesId IN (${secretSeries.map(() => '?').join(',')}) AND ca.archived = 0`,
      secretSeries.map(x => x.id));
    revealedCount = row.length ? Math.min(row[0].c, slotsTotal) : 0;
  }
  res.json({
    status: "success",
    data: {
      enabled: secretSeries.length > 0,
      seriesCount: secretSeries.length,
      slotsTotal,
      revealedCount
    }
  });
});

// Сетка секретного кейса.
// Контракт снят с index-B3loti9-.js: data.slotsTotal и data.slots[].slotIndex,
// revealedCount считается по открытым слотам. Раньше отдавался плоский список
// всего каталога (5430 позиций), и сетка не строилась.
app.get('/api/v1/cases/:slug/grid', async (req, res) => {
  const slug = req.params.slug;
  const dbCases = await queryAdminDb(`SELECT * FROM cases WHERE slug = ? OR id = ?`, [slug, slug]);
  const c = dbCases[0];
  const items = await getCaseItemsFromDb(c ? c.id : null);
  const slotsTotal = Number(process.env.SECRET_SLOTS || 24);

  // Раскрыты только те слоты, под которыми реально лежит предмет из состава
  // кейса. Остальные остаются закрытыми знаком вопроса.
  const slots = items.slice(0, slotsTotal).map((it, idx) => ({
    slotIndex: idx,
    revealed: true,
    item: {
      id: it.id, name: it.name, image: fixImageUrl(it.image),
      price: it.price, rarity: it.rarity, color: it.color
    }
  }));

  res.json({
    status: "success",
    data: { slug, slotsTotal, revealedCount: slots.length, slots }
  });
});

app.get('/api/v1/cases/:slug/best', async (req, res) => {
  try {
    const slug = req.params.slug;
    const dbCases = await queryAdminDb(`SELECT * FROM cases WHERE slug = ? OR id = ?`, [slug, slug]);
    const c = dbCases[0];
    const items = await getCaseItemsFromDb(c ? c.id : null);
    const nowSec = Math.floor(Date.now() / 1000);

    const drops = items.slice(0, 5).map((it, idx) => ({
      itemId: it.id,
      id: it.id,
      name: it.name,
      imageUrl: fixImageUrl(it.image),
      image: fixImageUrl(it.image),
      value: it.price,
      price: it.price,
      rarity: it.rarity || "GOLD",
      color: it.color ? it.color.replace('#', '') : "eb4b4b",
      userId: `user-${idx + 1}`,
      userName: `Player_${idx + 1}`,
      openedAt: nowSec - (idx * 3600)
    }));

    res.json({ status: "success", data: { drops: drops } });
  } catch (e) {
    res.json({ status: "success", data: { drops: [] } });
  }
});

app.get('/api/v1/cases/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    let dbCases = await queryAdminDb(`SELECT * FROM cases WHERE slug = ? OR id = ?`, [slug, slug]);
    let c = dbCases[0];

    if (!c) {
      const all = await queryAdminDb(`SELECT * FROM cases WHERE archived = 0 OR isActive = 1 ORDER BY id ASC LIMIT 1`);
      c = all[0];
    }

    const requestedSlug = slug || (c ? c.slug : "rust-starter");

    const seriesRows = c && (c.seriesId || c.series_id)
      ? await queryAdminDb(`SELECT isLimited, isSecret FROM series WHERE id = ?`, [c.seriesId || c.series_id])
      : [];
    const seriesFlags = seriesRows[0] || {};

    const caseObj = {
      id: requestedSlug,
      slug: requestedSlug,
      name: c ? (c.name || "Кейс Kaban.gg") : "Халявный Кабан",
      category: c ? (c.category || "standard") : "standard",
      price: c ? (c.price || 49) : 49,
      oldPrice: Math.round((c ? (c.price || 49) : 49) * 1.5),
      image: fixImageUrl(c ? c.image : "/assets/header/logo.webp"),
      volatility: (c ? (c.volatility || "AVERAGE") : "AVERAGE").toUpperCase(),
      isActive: c ? (c.isActive === 1 || c.status === 'active' || c.isActive == null) : true,
      seriesId: c ? (c.seriesId || c.series_id || 1) : 1,
      // isLimited/isSecret хранятся на серии, а не на кейсе: в таблице cases
      // таких колонок нет и обращение к ним всегда давало undefined.
      limited: seriesFlags.isLimited === 1,
      secret: seriesFlags.isSecret === 1
    };

    let items = await getCaseItemsFromDb(c ? c.id : null);
    if (!items || items.length === 0) items = await getFallbackItems();

    // Показываем РЕАЛЬНЫЕ шансы — те же веса, по которым идёт розыгрыш в
    // /cases/open. Раньше отдавался сырой chance из БД (везде 0 → подставлялось
    // 10%), а разыгрывалось равновероятно: цифры на экране не совпадали с игрой.
    const user = await currentUser(req, mockUser);
    const dist = buildDistribution(items, {
      casePrice: caseObj.price,
      rtp: Number(user && user.rtp) || DEFAULT_RTP
    });
    const chanceById = new Map(chancesForDisplay(dist).map(c => [String(c.id), c.chance]));
    items = items.map(it => ({ ...it, chance: chanceById.get(String(it.id)) ?? it.chance }));

    res.json({
      status: "success",
      data: {
        case: { ...caseObj, rtp: dist.rtpActual },
        items
      }
    });
  } catch (e) {
    console.error("GET /cases/:slug error:", e);
    const requestedSlug = req.params.slug || "rust-starter";
    res.json({
      status: "success",
      data: {
        case: {
          id: requestedSlug,
          slug: requestedSlug,
          name: "Кейс Kaban.gg",
          category: "standard",
          price: 49,
          oldPrice: 99,
          image: "/assets/header/logo.webp",
          volatility: "AVERAGE",
          isActive: true,
          seriesId: 1,
          limited: false,
          secret: false
        },
        items: await getFallbackItems()
      }
    });
  }
});

function mapRarity(r) {
  if (!r) return "REGULAR";
  const upper = String(r).toUpperCase().trim();
  if (upper === "COVERT" || upper === "MYTHIC" || upper === "GOLD") return "GOLD";
  if (upper === "CLASSIFIED" || upper === "LEGENDARY" || upper === "VIOLET") return "VIOLET";
  if (upper === "RESTRICTED" || upper === "RARE") return "RARE";
  if (upper === "MIL_SPEC" || upper === "UNUSUAL") return "UNUSUAL";
  return "REGULAR";
}

async function getCaseItemsFromDb(caseId) {
  if (caseId) {
    const rows = await queryAdminDb(`
      SELECT ci.*, i.name, i.price, i.image, i.rarity, i.color, i.market_hash_name
      FROM case_items ci
      JOIN items i ON ci.item_id = i.id
      WHERE ci.case_id = ?
    `, [caseId]);

    if (rows && rows.length > 0) {
      return rows.map(r => ({
        id: r.item_id || r.id,
        name: r.name || r.market_hash_name || "Rust Skin Item",
        price: r.price || 100,
        image: fixImageUrl(r.image),
        rarity: mapRarity(r.rarity),
        color: r.color ? (r.color.startsWith('#') ? r.color : `#${r.color}`) : "#eb4b4b",
        // Ноль здесь означает «в админке шанс не задан», и buildDistribution
        // посчитает веса от цены кейса и RTP. Прежняя подстановка 10 по
        // умолчанию делала все предметы равновероятными и ломала отдачу.
        chance: Number(r.chance) || 0,
        ticketRangeFrom: Number(r.ticketRangeFrom) || 0,
        ticketRangeTo: Number(r.ticketRangeTo) || 0
      }));
    }
  }

  return await getFallbackItems();
}

async function getFallbackItems() {
  const liveItems = await getLiveItems();
  if (liveItems && liveItems.length > 0) {
    return liveItems.map(it => ({
      id: typeof it.id === 'string' && it.id.startsWith('db-') ? parseInt(it.id.replace('db-', '')) : (parseInt(it.id) || 1),
      name: it.name || "Rust Skin Item",
      price: it.price || 100,
      image: fixImageUrl(it.image),
      rarity: mapRarity(it.rarity),
      color: it.colorHex || it.color || "#eb4b4b",
      chance: 0
    }));
  }
  return [
    { id: 1, name: "AK-47 | Tempered", price: 4500, image: "/assets/battles/winner-boar.png", rarity: "GOLD", color: "#eb4b4b", chance: 0 },
    { id: 2, name: "LR-300 | Victoria", price: 1200, image: "/assets/battles/boar-ready.png", rarity: "VIOLET", color: "#a33ee2", chance: 0 },
    { id: 3, name: "MP5 | Cold Hunter", price: 350, image: "/assets/header/logo.webp", rarity: "RARE", color: "#65dc04", chance: 0 },
    { id: 4, name: "Metal Facemask", price: 850, image: "/assets/battles/winner-boar.png", rarity: "VIOLET", color: "#a33ee2", chance: 0 },
    { id: 5, name: "Whiteout Semi-Automatic Pistol", price: 2400, image: "/assets/header/logo.webp", rarity: "UNUSUAL", color: "#4076ff", chance: 0 }
  ];
}

app.post(['/api/v1/cases/open', '/api/v1/cases/:slug/open'], async (req, res) => {
  try {
    const slug = req.body.slug || req.params.slug || 'limit';
    const quantity = parseInt(req.body.quantity || req.body.count || 1) || 1;

    const dbCases = await queryAdminDb(`SELECT * FROM cases WHERE slug = ? OR id = ?`, [slug, slug]);
    const c = dbCases[0];
    const casePrice = c ? (c.price || 49) : 49;
    const totalCost = casePrice * quantity;

    const user = (await currentUser(req, mockUser)) || guestUser();

    const items = await getCaseItemsFromDb(c ? c.id : null);
    const drops = [];
    const nowSec = Math.floor(Date.now() / 1000);

    // Взвешенный розыгрыш вместо равновероятного выбора.
    // Веса берутся из ticketRange, если он заполнен; иначе из chance;
    // иначе считаются от цены кейса и RTP игрока (см. services/drops.js).
    const rtp = Number(user && user.rtp) || DEFAULT_RTP;
    const distribution = buildDistribution(items, { casePrice, rtp });

    // ВАЖЕН ПОРЯДОК: сначала проверяем сам кейс, и только потом трогаем деньги.
    // Иначе за отклонённое открытие всё равно списывалась цена кейса.
    //
    // Защита от заведомо убыточного кейса. Возникает, когда состав кейса битый:
    // например, из шести предметов пять ссылались на удалённые строки items, и
    // оставался один за 15 400 ₽ в кейсе за 499 ₽ — отдача 3086%.
    if (distribution.entries.length === 0 || distribution.rtpActual > MAX_RTP) {
      console.error(`[Cases] Кейс "${slug}" настроен неверно: предметов ${distribution.entries.length}, отдача ${distribution.rtpActual}%`);
      return res.status(409).json({
        status: "error",
        code: "CASE_MISCONFIGURED",
        message: distribution.entries.length === 0
          ? "В кейсе нет доступных предметов. Проверьте состав в админке."
          : `Отдача кейса ${distribution.rtpActual}% при пороге ${MAX_RTP}%. Открытие заблокировано — проверьте состав в админке.`,
        data: { itemsAvailable: distribution.entries.length, rtp: distribution.rtpActual, maxRtp: MAX_RTP }
      });
    }

    const balanceBefore = await getBalance(req, mockUser);
    if (balanceBefore < totalCost) {
      return res.status(400).json({
        status: "error", code: "INSUFFICIENT_BALANCE",
        message: `Недостаточно средств: нужно ${totalCost} ₽, на балансе ${balanceBefore} ₽`
      });
    }
    let balanceAfter = await adjustBalance(req, mockUser, -totalCost);

    // Честный бросок с ПРЕДВАРИТЕЛЬНОЙ фиксацией сида: хэш серверного сида
    // опубликован до игры (GET /fair/state), сам сид раскрывается только при
    // смене пары. Раньше сид генерировался на каждое открытие и тут же
    // раскрывался — проверить бросок было можно, доказать честность заранее нет.
    const fair = await fairness.nextRoll(user.id, 'case', quantity);
    const serverHash = fair.serverHash;
    const clientSeed = fair.clientSeed;

    for (let i = 0; i < quantity; i++) {
      const winningItem = pickByRoll(distribution.entries, fair.rolls[i].roll) || {
        id: 0, name: "Кейс пуст", price: 0,
        image: "/assets/battles/winner-boar.png", rarity: "REGULAR", color: "#756767"
      };

      // Реальное открытие попадает в живую ленту и вытесняет синтетику.
      pushLiveDrop(makeWin({
        item: {
          name: winningItem.name,
          price: winningItem.price,
          image: winningItem.image,
          rarity: winningItem.rarity,
          colorHex: winningItem.color
        },
        user: { id: user.id, name: user.username, avatar: user.avatar },
        eventType: 'CASE',
        caseSlug: slug,
        caseImage: c ? c.image : null,
        betAmount: casePrice,
        wonAt: nowSec
      }));

      drops.push({
        itemId: winningItem.id,
        id: winningItem.id,
        name: winningItem.name,
        imageUrl: fixImageUrl(winningItem.image),
        image: fixImageUrl(winningItem.image),
        value: winningItem.price,
        price: winningItem.price,
        rarity: winningItem.rarity || "GOLD",
        color: winningItem.color ? winningItem.color.replace('#', '') : "eb4b4b",
        userId: user.id,
        userName: user.username,
        openedAt: nowSec
      });
    }

    const winnings = drops.reduce((a, d) => a + (Number(d.price) || 0), 0);

    // Предметы кладём в инвентарь. При AUTO_SELL_WINS=1 сервис сам переведёт
    // их в деньги — это прежнее поведение, оставлено переключателем.
    for (const d of drops) {
      await inventory.award(user.id, {
        id: d.id, name: d.name, image: d.image, price: d.price,
        rarity: d.rarity, color: d.color
      }, { source: 'case', ref: slug });
    }
    balanceAfter = await getBalance(req, mockUser);
    await recordTransaction(req, 'case_open', -totalCost, `Открытие: ${c ? c.name : slug} x${quantity}`);
    await recordTransaction(req, 'case_win', winnings, drops.map(d => d.name).join(', ').slice(0, 200));

    res.json({
      status: "success",
      data: {
        gameId: Date.now(),
        // Фронт читает openResult.items и openResult.winnings (index-B3loti9-.js).
        // drops оставлен как совместимый дубль.
        items: drops,
        drops: drops,
        winnings,
        newBalance: balanceAfter,
        balance: balanceAfter,
        // serverHash опубликован ДО игры. Сам serverSeed раскрывается при смене
        // пары сидов (POST /fair/rotate) — тогда все прошлые броски проверяемы
        // против уже опубликованного хэша.
        serverHash,
        clientSeed,
        nonce: fair.startNonce + quantity - 1,
        rtp: distribution.rtpActual,
        weightsSource: distribution.source
      }
    });
  } catch (e) {
    console.error("POST /cases/open error:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// --- MOCK & ADMIN SYNCHRONIZED API ROUTES ---

// --- AUTH: вход через Steam OpenID (services/auth.js) ---
// Регистрирует /auth/steam, /auth/steam/return, /auth/refresh, /auth/me, /auth/logout
// и вешает attachAuth: после него req.auth = payload Bearer-токена (или null).
registerAuthRoutes(app, { mockUser });

// User profile endpoints
// Всегда 200. Гостю отдаём пустой профиль: 401 здесь вешает фронт намертво
// (см. комментарий к guestUser() в services/auth.js).
app.get(['/api/v1/user', '/api/v1/user/me', '/api/v1/users/me', '/api/v1/profile'], async (req, res) => {
  const user = await currentUser(req, mockUser);
  res.json({ status: "success", data: user || guestUser() });
});

// Считается по инвентарю и транзакциям игрока, а не выдаётся константой.
app.get('/api/v1/user/stats', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    return res.json({ status: "success", data: { openedCases: 0, wonAmount: 0, totalBattles: 0, upgrades: 0, inventoryCount: 0, inventoryValue: 0, bestDrop: null } });
  }
  res.json({ status: "success", data: await inventory.userStats(user.id) });
});

app.get('/api/v1/user/ban-status', (req, res) => {
  res.json({ status: "success", data: { banned: false } });
});

// Избранное хранится в user_favorites, а не подставляется первым кейсом.
app.get('/api/v1/user/favorites', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) return res.json({ status: "success", data: [] });
  await ensureFavoritesSchema();
  const rows = await queryAdminDb(
    `SELECT case_slug FROM user_favorites WHERE user_id = ? ORDER BY id DESC`, [String(user.id)]);
  res.json({ status: "success", data: rows.map(r => r.case_slug) });
});

app.post(['/api/v1/user/favorites', '/api/v1/user/favorites/:slug'], async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) return res.status(401).json({ status: "error", message: "Нужна авторизация" });
  const slug = req.params.slug || req.body?.slug;
  if (!slug) return res.status(400).json({ status: "error", message: "Не указан кейс" });
  await ensureFavoritesSchema();
  await new Promise((resolve) => {
    const db = getAdminDb(); if (!db) return resolve();
    db.run(`INSERT OR IGNORE INTO user_favorites (user_id, case_slug) VALUES (?, ?)`,
      [String(user.id), slug], () => { db.close(); resolve(); });
  });
  res.json({ status: "success", data: { slug, favorite: true } });
});

app.delete('/api/v1/user/favorites/:slug', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) return res.status(401).json({ status: "error", message: "Нужна авторизация" });
  await ensureFavoritesSchema();
  await new Promise((resolve) => {
    const db = getAdminDb(); if (!db) return resolve();
    db.run(`DELETE FROM user_favorites WHERE user_id = ? AND case_slug = ?`,
      [String(user.id), req.params.slug], () => { db.close(); resolve(); });
  });
  res.json({ status: "success", data: { slug: req.params.slug, favorite: false } });
});

app.put(['/api/v1/user/tradeurl', '/api/v1/user/display-name', '/api/v1/user/avatar'], async (req, res) => {
  const tradeLink = req.body.tradeLink || req.body.tradeUrl;
  const username = req.body.username || req.body.displayName;

  // Авторизованный пользователь — пишем в БД, иначе правим мок (dev).
  if (req.auth && !req.auth.mock) {
    const sets = [];
    const params = [];
    if (tradeLink) { sets.push('trade_link = ?'); params.push(tradeLink); }
    if (username) { sets.push('username = ?'); params.push(username); }
    if (sets.length) {
      params.push(req.auth.sub);
      await new Promise((resolve) => {
        const db = getAdminDb();
        if (!db) return resolve();
        db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params, () => { db.close(); resolve(); });
      });
    }
    return res.json({ status: "success", data: await currentUser(req, mockUser) });
  }

  if (tradeLink) mockUser.tradeLink = tradeLink;
  if (username) mockUser.username = username;
  res.json({ status: "success", data: mockUser });
});

// Config endpoints
app.get(['/api/v1/config', '/api/v1/config/games', '/api/v1/game/config'], async (req, res) => {
  // Режимы берутся из game_configs, которую правит админка. Имена там свои
  // ('cases', 'battles', 'upgrader'), а фронт знает 'case_opening', 'battle',
  // 'upgrade' — поэтому сопоставляем явно.
  const MAP = { cases: 'case_opening', battles: 'battle', upgrader: 'upgrade', deposit_chain: 'deposit_chain' };
  const data = await cached('siteConfig', 30000, async () => {
    const rows = await queryAdminDb(`SELECT id, enabled FROM game_configs`);
    const modes = mockConfig.modes.map(m => ({ ...m }));
    for (const r of rows) {
      const frontName = MAP[r.id];
      const mode = modes.find(m => m.name === frontName);
      if (mode) mode.enabled = r.enabled === 1;
    }
    const td = await adminSetting('topdrops', { visible: true });
    return { ...mockConfig, modes, topDropsVisible: td.visible !== false };
  });
  res.json({ status: "success", data: { config: data, modes: data.modes } });
});

app.get(['/api/v1/config/socials', '/config/socials'], async (req, res) => {
  const links = await cached('siteSocials', 30000, async () => {
    const rows = await queryAdminDb(`SELECT name, url FROM social_links WHERE enabled = 1 ORDER BY position ASC`);
    return rows.filter(r => r.url).map(r => ({ name: r.name, url: r.url }));
  });
  if (links.length) return res.json({ status: "success", data: { links } });
  // Таблицы ещё нет — отдаём прежний список, чтобы блок не опустел.
  res.json({
    status: "success",
    data: {
      links: [
        { name: "Telegram", url: "https://t.me/kabangg" },
        { name: "VK", url: "https://vk.com/kabangg" }
      ]
    }
  });
});

// Promo code endpoints
// Промокоды.
//
// Было: принимался ЛЮБОЙ код и начислял фиксированную сумму — способ
// бесконечно пополнять баланс. Таблица promo_codes в админке существовала,
// но сервер в неё не смотрел.
//
// Стало: код ищется в базе, проверяются активность, срок, лимит использований,
// минимальный депозит и повторное применение одним игроком.

let promoSchemaReady = false;
async function ensurePromoSchema() {
  if (promoSchemaReady) return;
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`CREATE TABLE IF NOT EXISTS promo_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promo_id INTEGER, user_id TEXT, amount REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(promo_id, user_id))`, () => { db.close(); resolve(); });
  });
  promoSchemaReady = true;
}

/** Общая проверка для validate и redeem. */
async function checkPromo(code, user, req) {
  await ensurePromoSchema();
  const norm = String(code || '').trim().toUpperCase();
  if (!norm) return { error: 'EMPTY', message: 'Введите промокод' };

  const rows = await queryAdminDb(
    `SELECT * FROM promo_codes WHERE UPPER(code) = ?`, [norm]);
  const p = rows[0];
  if (!p) return { error: 'NOT_FOUND', message: 'Промокод не найден' };
  if (p.active === 0) return { error: 'INACTIVE', message: 'Промокод отключён' };
  if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) {
    return { error: 'EXPIRED', message: 'Срок действия промокода истёк' };
  }
  if (p.uses_limit > 0 && p.uses_count >= p.uses_limit) {
    return { error: 'LIMIT_REACHED', message: 'Лимит использований исчерпан' };
  }
  if (!user || user.isGuest) return { error: 'UNAUTHORIZED', message: 'Войдите, чтобы применить промокод' };

  const used = await queryAdminDb(
    `SELECT id FROM promo_uses WHERE promo_id = ? AND user_id = ?`, [p.id, String(user.id)]);
  if (used.length) return { error: 'ALREADY_USED', message: 'Вы уже применяли этот промокод' };

  if (p.min_deposit > 0) {
    const dep = await queryAdminDb(
      `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type = 'deposit'`,
      [String(user.id)]);
    const total = Number(dep[0]?.s || 0);
    if (total < p.min_deposit) {
      return { error: 'MIN_DEPOSIT', message: `Нужен депозит от ${p.min_deposit} ₽ (у вас ${Math.round(total)} ₽)` };
    }
  }
  return { ok: true, promo: p };
}

app.post('/api/v1/promo/redeem', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  const r = await checkPromo(req.body?.code, user, req);
  if (r.error) {
    return res.status(r.error === 'UNAUTHORIZED' ? 401 : 400)
      .json({ status: 'error', code: r.error, message: r.message });
  }

  const p = r.promo;
  const amount = Number(p.value) || 0;
  const balance = await adjustBalance(req, mockUser, amount);

  await new Promise((resolve) => {
    const db = getAdminDb(); if (!db) return resolve();
    db.run(`INSERT OR IGNORE INTO promo_uses (promo_id, user_id, amount) VALUES (?, ?, ?)`,
      [p.id, String(user.id), amount], () => { db.close(); resolve(); });
  });
  await new Promise((resolve) => {
    const db = getAdminDb(); if (!db) return resolve();
    db.run(`UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ?`, [p.id],
      () => { db.close(); resolve(); });
  });
  await recordTransaction(req, 'promo', amount, `Промокод ${p.code}`);

  res.json({
    status: 'success',
    data: { success: true, code: p.code, amount, newBalance: balance, balance },
    message: `Промокод «${p.code}» применён: +${amount} ₽ на баланс`
  });
});

app.post('/api/v1/promo/validate', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  const r = await checkPromo(req.body?.code || req.query?.code, user, req);
  if (r.error) {
    return res.status(400).json({ status: 'error', code: r.error, message: r.message, data: { valid: false } });
  }
  res.json({
    status: 'success',
    data: { valid: true, code: r.promo.code, kind: r.promo.kind, value: r.promo.value }
  });
});

app.get('/api/v1/promo/active', async (req, res) => {
  const rows = await queryAdminDb(
    `SELECT code, kind, value, min_deposit, expires_at FROM promo_codes
     WHERE active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND (uses_limit = 0 OR uses_count < uses_limit)
     ORDER BY value DESC LIMIT 1`);
  res.json({ status: 'success', data: rows[0] || null });
});

// Banners (Synchronized with admin.titanrust.ru)
app.get(['/api/v1/banners', '/api/v1/banner', '/banners'], async (req, res) => {
  const banners = await getLiveBanners();
  res.json({
    status: "success",
    data: {
      banners: banners
    }
  });
});

// Live recent drops
// Лента дропов.
//
// Форма ответа снята с бандла (store-CfUBv1CE.js):
//   data.wins[].{ sourceEventId, userId, userName, avatarUrl, steamLevel, wonAt,
//                 eventType, itemName, itemImage, itemValue, betAmount, winAmount,
//                 multiplier, isBigWin, caseImage, caseSlug, itemColor, itemRarity }
// eventType — ключ карты {CASE:"case", BATTLE:"cratebattle", UPGRADER:"upgrader"}.
// itemRarity проходит валидатор из rarity-*.js, поэтому только пять тиров сайта.
// Раньше сервер отдавал плоский массив с другими именами полей — фронт читал
// data.wins, получал undefined, и лента оставалась пустой.
app.get(['/api/v1/live/recent', '/api/v1/drops/recent'], async (req, res) => {
  const mode = String(req.query.mode || 'live');
  const limit = Math.min(parseInt(req.query.limit) || 40, 100);
  res.json({ status: "success", data: { wins: await getLiveFeed(mode, limit) } });
});

// Stats
// Реальные счётчики из транзакций. Онлайн считаем по активности за 15 минут,
// подмешивая базовый фон из BASE_ONLINE, чтобы пустой сайт не выглядел мёртвым.
app.get(['/api/v1/stats/global', '/api/v1/stats'], async (req, res) => {
  const data = await cached('globalStats', 30000, async () => {
    const one = async (sql) => Number((await queryAdminDb(sql))[0]?.v || 0);
    const opened = await one("SELECT COUNT(*) AS v FROM transactions WHERE type='case_open'");
    const upgrades = await one("SELECT COUNT(*) AS v FROM transactions WHERE type='upgrade'");
    const battlesN = await one("SELECT COUNT(*) AS v FROM battles WHERE status='finished'");
    const active = await one(
      "SELECT COUNT(DISTINCT user_id) AS v FROM transactions WHERE created_at >= datetime('now','-15 minutes')");
    return {
      onlineCount: Number(process.env.BASE_ONLINE || 0) + active,
      openedCasesCount: opened,
      upgradesCount: upgrades,
      battlesCount: battlesN
    };
  });
  res.json({ status: "success", data });
});

// Deposit chain state
// «Бесплатные кейсы за депозит».
//
// Контракт снят с useDepositChain-CTOMFCQw.js:
//   data.{ showLadder, variant, completed, currency, activeTierIndex, tiers }
//   tiers[].{ threshold, collected, tierIndex, status }   status:'ready' — можно открыть
//
// Важно: блок рендерится только когда enabled = isAuthed && isDepositChainEnabled.
// Гостю он не покажется независимо от ответа сервера — это поведение фронта.
// Раньше tiers был пустым массивом, поэтому блок не появлялся и у авторизованных.
// Лестница «Бесплатные кейсы за депозит».
//
// Поля тира читаются фронтом как caseName и caseImage (index-DoTdMb5b.js),
// а не name/image — из-за этого лестница рисовалась, но без картинок и
// названий кейсов.
//
// Статусы, которые понимает вёрстка: opened, ready, collecting, locked.
// Значения по умолчанию; реальные тиры берутся из настроек админки.
const DEPOSIT_TIERS_FALLBACK = [
  { name: 'Камень',  threshold: 0 },
  { name: 'Лук',     threshold: 174 },
  { name: 'Двушка',  threshold: 384 },
  { name: 'Томпсон', threshold: 821 },
  { name: 'Калаш',   threshold: 1166 }
];

async function depositTiersConfig() {
  const cfg = await adminSetting('deposit_chain', {});
  return Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : DEPOSIT_TIERS_FALLBACK;
}

/** Настройка одного тира — нужна при открытии, чтобы найти привязанный кейс. */
async function tierConfigAt(idx) {
  const tiers = await depositTiersConfig();
  return tiers[idx] || null;
}

/** Какие тиры игрок уже забрал. Ключ — id пользователя. */
const claimedTiers = new Map();

const TIER_FALLBACK_IMAGE = '/uploads/cases/1786522990114-495918520.webp';

/** Есть ли файл картинки на диске: в базе встречаются ссылки на удалённые загрузки. */
function imageOnDisk(img) {
  return !!(img && String(img).startsWith('/') && fs.existsSync(path.join(PUBLIC_DIR, img)));
}

/**
 * Кейс, к которому привязан тир.
 *
 * Тир может ссылаться на настоящий кейс: `{ name, threshold, slug: 'case-4' }`.
 * Тогда с него берутся название, картинка и состав. Если ссылки нет — берём
 * кейс по порядковому номеру, как было раньше.
 */
function tierCase(tier, idx, cases) {
  const slug = tier && (tier.slug || tier.caseSlug || tier.case);
  if (slug) {
    const found = cases.find(c => String(c.slug) === String(slug) || String(c.id) === String(slug));
    if (found) return found;
  }
  return cases[idx % Math.max(cases.length, 1)] || null;
}

function tierImage(tier, idx, cases) {
  // Приоритет: картинка, заданная в настройке тира -> картинка привязанного
  // кейса -> любой кейс с живой картинкой -> общий запасной файл.
  if (imageOnDisk(tier && tier.image)) return tier.image;
  const c = tierCase(tier, idx, cases);
  if (c && imageOnDisk(c.image)) return c.image;
  // Разные тиры не должны выглядеть одинаково: ищем первый неиспользованный
  // кейс с существующей картинкой, начиная со своего индекса.
  for (let i = 0; i < cases.length; i++) {
    const alt = cases[(idx + i) % cases.length];
    if (alt && imageOnDisk(alt.image)) return alt.image;
  }
  return TIER_FALLBACK_IMAGE;
}

async function buildDepositTiers(req, mockUser) {
  const user = (await currentUser(req, mockUser)) || guestUser();
  const key = String(user.id || 'guest');
  const claimed = claimedTiers.get(key) || new Set();

  // Сумма депозитов игрока — из истории операций.
  let collected = 0;
  if (req.auth && !req.auth.mock) {
    await ensureTxSchema();
    const rows = await queryAdminDb(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND type = 'deposit'`,
      [req.auth.sub]);
    collected = rows.length ? Number(rows[0].s) || 0 : 0;
  }

  const cases = await getLiveCases();

  const TIERS = await depositTiersConfig();
  const tiers = TIERS.map((t, idx) => {
    let status;
    if (claimed.has(idx)) status = 'opened';
    else if (collected >= t.threshold) status = 'ready';
    else status = 'locked';
    const src = tierCase(t, idx, cases);
    const img = tierImage(t, idx, cases);
    const label = t.name || (src && src.name) || `Кейс ${idx + 1}`;
    return {
      tierIndex: idx,
      caseName: label,
      caseImage: img,
      // Дубли под другим именем — на случай, если где-то читается name/image.
      name: label,
      image: img,
      caseSlug: src ? src.slug : null,
      threshold: t.threshold,
      collected: Math.min(collected, t.threshold),
      status
    };
  });

  // Первый незабранный тир, который ещё копится, помечаем как collecting —
  // именно он показывает прогресс «до следующего кейса».
  const collecting = tiers.find(t => t.status === 'locked');
  if (collecting) collecting.status = 'collecting';

  const readyIdx = tiers.findIndex(t => t.status === 'ready');
  const activeTierIndex = readyIdx !== -1
    ? readyIdx
    : Math.max(0, tiers.findIndex(t => t.status === 'collecting'));

  return { user, key, claimed, collected, tiers, activeTierIndex };
}

app.get(['/api/v1/deposit-chain/state', '/api/v1/deposit-chain'], async (req, res) => {
  const { tiers, activeTierIndex, collected } = await buildDepositTiers(req, mockUser);
  res.json({
    status: "success",
    data: {
      active: true,
      step: activeTierIndex + 1,
      showLadder: true,
      variant: "A",
      completed: tiers.every(t => t.status === 'opened'),
      currency: "RUB",
      totalCollected: collected,
      activeTierIndex,
      tiers
    }
  });
});

// Забрать бесплатный кейс тира. Фронт зовёт это из openTier().
//
// Коды ошибок читаются бандлом (index-B3loti9-.js) и должны быть ровно эти:
// CHAIN_UNAVAILABLE, CHAIN_OUT_OF_ORDER, CHAIN_INSUFFICIENT_DEPOSIT.
// Любой другой код уходит в общий тост «что-то пошло не так».
app.post('/api/v1/deposit-chain/open', async (req, res) => {
  const tierIndex = Number(req.body?.tierIndex);
  const { key, claimed, tiers } = await buildDepositTiers(req, mockUser);
  const tier = tiers[tierIndex];

  if (!tier) {
    return res.status(400).json({ status: "error", code: "CHAIN_UNAVAILABLE", message: "Такого тира нет" });
  }
  if (tier.status === 'opened') {
    return res.status(409).json({ status: "error", code: "CHAIN_OUT_OF_ORDER", message: "Этот кейс уже забран" });
  }
  if (tier.status !== 'ready') {
    return res.status(403).json({
      status: "error", code: "CHAIN_INSUFFICIENT_DEPOSIT",
      message: `Нужно пополнить ещё ${tier.threshold - tier.collected} ₽`
    });
  }

  // Разыгрываем содержимое по тем же правилам, что и обычный кейс.
  const cases = await getLiveCases();
  const src = tierCase(await tierConfigAt(tierIndex), tierIndex, cases);
  // Пул берём из каталога по цене тира, а не из состава кейса: составы бывают
  // битыми, и бесплатный кейс за 0 руб выдавал предмет за 15 400 руб.
  const nominal = Math.max(tier.threshold, 50);
  const picked = await queryItems({ minPrice: 10, maxPrice: nominal * 3, limit: 40, sort: 'asc' });
  const pool = picked.items.length ? picked.items : await getFallbackItems();
  const dist = buildDistribution(pool, { casePrice: nominal, rtp: DEFAULT_RTP });

  const { serverSeed, serverHash } = newServerSeed();
  const clientSeed = String(req.body?.clientSeed || crypto.randomBytes(8).toString('hex'));
  const rolled = rollOne(dist, { serverSeed, clientSeed, nonce: tierIndex });
  const item = rolled.item || pool[0];

  claimed.add(tierIndex);
  claimedTiers.set(key, claimed);

  const value = Number(item?.price) || 0;
  const balance = await adjustBalance(req, mockUser, value);
  await recordTransaction(req, 'deposit_chain', value, `Бесплатный кейс: ${tier.caseName}`);

  const user = (await currentUser(req, mockUser)) || guestUser();
  if (item) {
    pushLiveDrop(makeWin({
      item: { name: item.name, price: value, image: item.image, rarity: item.rarity, colorHex: item.color },
      user: { id: user.id, name: user.username, avatar: user.avatar },
      eventType: 'CASE', caseSlug: src ? src.slug : '', caseImage: tier.caseImage,
      betAmount: 0, wonAt: Math.floor(Date.now() / 1000)
    }));
  }

  // Форма ответа снята с бандла, а не придумана. index-B3loti9-.js делает:
  //   const t = await u.openTier(e);
  //   return { items: [Ut(t.item)], winnings: Number(t.winAmount) };
  // то есть читает ОДИН предмет в поле `item` и сумму в `winAmount`.
  // А Ut() внутри берёт e.itemId и сразу зовёт e.rarity.toUpperCase().
  //
  // Сервер отдавал `items: [...]` и `winnings` — фронт получал undefined,
  // Ut падал на `.rarity` пустого объекта, исключение уходило в общий catch,
  // и кейс не открывался вообще. Ошибка выглядела как «что-то пошло не так».
  const payload = item ? {
    itemId: item.id,
    id: item.id,
    name: item.name,
    image: fixImageUrl(item.image),
    price: value,
    // rarity обязана быть строкой: Ut() зовёт toUpperCase() без проверки.
    rarity: item.rarity || 'REGULAR',
    color: item.color
  } : null;

  res.json({
    status: "success",
    data: {
      tierIndex,
      item: payload,
      winAmount: value,
      // Дубли под прежними именами — на случай, если их где-то ещё читают.
      items: payload ? [payload] : [],
      winnings: value,
      newBalance: balance,
      serverHash, serverSeed, clientSeed, nonce: tierIndex
    }
  });
});
// Upgrader endpoints
// Каталог апгрейдера.
//
// Форма ответа снята с бандла (index-BHZ_nufV.js):
//   queryFn -> e.items, getNextPageParam -> e.pagination.{page,limit,total}
// то есть items и pagination лежат на ВЕРХНЕМ уровне тела, а не внутри data.
// Фронт шлёт page, limit, priceMin, priceMax, search, sort.
//
// Раньше отдавался плоский массив всего каталога (1.9 МБ на запрос), фронт
// читал e.items -> undefined и показывал «Предметы не найдены».
app.get(['/api/v1/upgrader/items', '/api/v1/upgrader'], async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 48, 200);
  const sort = String(req.query.sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const result = await cached(
    `upg:${page}:${limit}:${req.query.priceMin || ''}:${req.query.priceMax || ''}:${req.query.search || ''}:${sort}`,
    30000,
    () => queryItems({
      search: req.query.search,
      minPrice: req.query.priceMin != null ? Number(req.query.priceMin) : undefined,
      maxPrice: req.query.priceMax != null ? Number(req.query.priceMax) : undefined,
      limit,
      offset: (page - 1) * limit,
      sort
    })
  );

  res.json({
    status: "success",
    items: result.items,
    pagination: { page, limit, total: result.total },
    // Дубль под общий конверт — на случай, если другой экран читает data.items.
    data: { items: result.items, pagination: { page, limit, total: result.total } }
  });
});

// Апгрейдер.
//
// Было: won = Math.random() > 0.4 — ровно 60% побед независимо от множителя и
// ставки, а выигрышем всегда назначался skins[0], самый дорогой предмет
// каталога (118 700 руб). То есть игра не зависела ни от одного действия игрока.
//
// Контракт снят с бандла (landing-mLe--Uh6.js):
//   запрос : { itemIds: [...], betAmount }
//   ответ  : { upgradeId, won, chance, betAmount, totalItemsValue, winAmount,
//              items, bestItem, ticket, serverSeed, serverSeedHash, nonce,
//              createdAt, creditPending }
// Оттуда же константы фронта: множители [2,4,5], RTP 0.95, минимальный шанс 1%,
// множитель от 1.05 до 100. chance — доля от 0 до 1 (гейдж умножает на 100).
//
// Формула: chance = (ставка / стоимость цели) * RTP.
// При этом ожидание = chance * цель = ставка * RTP, то есть отдача равна RTP
// при любом множителе — игрок не может выбрать «выгодный» множитель.
const UPGRADER_RTP = Number(process.env.UPGRADER_RTP || 0.95);
const UPGRADER_MIN_CHANCE = 0.01;
const UPGRADER_MAX_CHANCE = 0.95;
const UPGRADER_MIN_MULT = 1.05;
const UPGRADER_MAX_MULT = 100;

app.post('/api/v1/upgrader/place', async (req, res) => {
  try {
    const body = req.body || {};
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
    const catalog = await getLiveItems();
    const byId = new Map(catalog.map(i => [String(i.id), i]));

    // Ставка: сумма выбранных предметов; если предметы не переданы —
    // betAmount как сумма в рублях.
    const wagered = itemIds.map(id => byId.get(String(id))).filter(Boolean);
    const itemsValue = wagered.reduce((a, i) => a + (Number(i.price) || 0), 0);
    const rawBet = Number(body.betAmount);

    // betAmount у фронта используется и как множитель (1.05..100), и как сумма.
    // Различаем по наличию выбранных предметов: с предметами это множитель.
    let betAmount;
    let targetValue;
    const explicitTarget = body.targetItemId != null ? byId.get(String(body.targetItemId)) : null;

    if (explicitTarget) {
      betAmount = itemsValue > 0 ? itemsValue : (Number.isFinite(rawBet) ? rawBet : 0);
      targetValue = Number(explicitTarget.price) || 0;
    } else if (itemsValue > 0 && Number.isFinite(rawBet) && rawBet >= UPGRADER_MIN_MULT && rawBet <= UPGRADER_MAX_MULT) {
      betAmount = itemsValue;
      targetValue = itemsValue * rawBet;
    } else {
      betAmount = itemsValue > 0 ? itemsValue : (Number.isFinite(rawBet) ? rawBet : 0);
      const mult = Number(body.multiplier) || 2;
      targetValue = betAmount * Math.min(Math.max(mult, UPGRADER_MIN_MULT), UPGRADER_MAX_MULT);
    }

    if (!(betAmount > 0) || !(targetValue > 0)) {
      return res.status(400).json({
        status: "error", code: "INVALID_UPGRADE",
        message: "Не выбраны предметы или не задан множитель"
      });
    }
    if (targetValue < betAmount * UPGRADER_MIN_MULT) {
      return res.status(400).json({
        status: "error", code: "INVALID_MULTIPLIER",
        message: `Множитель должен быть не меньше ${UPGRADER_MIN_MULT}`
      });
    }

    const balanceBefore = await getBalance(req, mockUser);
    if (balanceBefore < betAmount) {
      return res.status(400).json({
        status: "error", code: "INSUFFICIENT_BALANCE",
        message: `Недостаточно средств: нужно ${Math.round(betAmount)} руб, на балансе ${balanceBefore} руб`
      });
    }

    const chance = Math.min(UPGRADER_MAX_CHANCE,
      Math.max(UPGRADER_MIN_CHANCE, (betAmount / targetValue) * UPGRADER_RTP));

    // Тот же честный бросок, что и в кейсах.
    const { serverSeed, serverHash } = newServerSeed();
    const clientSeed = String(body.clientSeed || crypto.randomBytes(8).toString('hex'));
    const nonce = Date.now() % 1000000;
    const ticket = fairFloat(serverSeed, clientSeed, nonce);
    const won = ticket < chance;

    // Предмет-цель: ближайший по стоимости из каталога, а не skins[0].
    let bestItem = explicitTarget;
    if (!bestItem) {
      bestItem = catalog.reduce((best, i) => {
        const d = Math.abs((Number(i.price) || 0) - targetValue);
        return !best || d < Math.abs((Number(best.price) || 0) - targetValue) ? i : best;
      }, null);
    }

    let balanceAfter = await adjustBalance(req, mockUser, -betAmount);
    const winAmount = won ? Math.round(targetValue) : 0;
    if (won) balanceAfter = await adjustBalance(req, mockUser, winAmount);

    await recordTransaction(req, 'upgrade', -Math.round(betAmount), `Апгрейд x${(targetValue / betAmount).toFixed(2)}`);
    if (won) await recordTransaction(req, 'upgrade_win', winAmount, bestItem ? bestItem.name : '');

    if (won && bestItem) {
      const user = (await currentUser(req, mockUser)) || guestUser();
      pushLiveDrop(makeWin({
        item: { name: bestItem.name, price: winAmount, image: bestItem.image, rarity: bestItem.rarity, colorHex: bestItem.colorHex },
        user: { id: user.id, name: user.username, avatar: user.avatar },
        eventType: 'UPGRADER',
        betAmount: Math.round(betAmount),
        multiplier: +(targetValue / betAmount).toFixed(2),
        wonAt: Math.floor(Date.now() / 1000)
      }));
    }

    res.json({
      status: "success",
      data: {
        upgradeId: `upg-${Date.now()}-${nonce}`,
        won,
        chance: +chance.toFixed(6),
        ticket: +ticket.toFixed(6),
        betAmount: Math.round(betAmount),
        totalItemsValue: Math.round(itemsValue || betAmount),
        winAmount,
        multiplier: +(targetValue / betAmount).toFixed(2),
        items: won && bestItem ? [{
          id: bestItem.id, name: bestItem.name, image: bestItem.image,
          price: winAmount, rarity: bestItem.rarity, color: bestItem.colorHex
        }] : [],
        bestItem: bestItem ? {
          id: bestItem.id, name: bestItem.name, image: bestItem.image,
          price: Math.round(targetValue), rarity: bestItem.rarity, color: bestItem.colorHex
        } : null,
        serverSeed,
        serverSeedHash: serverHash,
        nonce,
        createdAt: new Date().toISOString(),
        creditPending: false,
        newBalance: balanceAfter,
        balance: balanceAfter
      }
    });
  } catch (e) {
    console.error('POST /upgrader/place error:', e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.post('/api/v1/upgrader/offer/accept', (req, res) => {
  res.json({ status: "success", message: "Предмет успешно получен" });
});

// Giveaways endpoints
// Моки розыгрышей удалены: реальные роуты объявлены ниже, в блоке РОЗЫГРЫШИ.
// Express берёт первый совпавший обработчик, поэтому дубли выше перекрывали их.


// Crate PVP / Battles endpoints
// --- ИНВЕНТАРЬ И ВЫВОД СКИНОВ ------------------------------------------------
// Пути сняты с бандла (wallet-rLlmihs3.js): фронт уже умеет показывать
// инвентарь для вывода и список заявок, серверной части не было.

async function requireUser(req, res) {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    res.status(401).json({ status: "error", code: "UNAUTHORIZED", message: "Нужна авторизация" });
    return null;
  }
  return user;
}

app.get(['/api/v1/wallet/skins/withdraw-inventory', '/api/v1/inventory'], async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const data = await inventory.list(user.id, { status: req.query.status || 'owned' });
  res.json({ status: "success", data, items: data.items, total: data.count });
});

app.post(['/api/v1/inventory/sell', '/api/v1/wallet/skins/sell'], async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const r = req.body?.all
    ? await inventory.sellAll(user.id)
    : await inventory.sell(user.id, req.body?.ids || req.body?.id);
  if (r.error) return res.status(400).json({ status: "error", code: r.error, message: r.message });
  res.json({ status: "success", data: r, message: `Продано предметов: ${r.sold} на ${r.payout} ₽` });
});

app.post('/api/v1/inventory/:id/sell', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const r = await inventory.sell(user.id, req.params.id);
  if (r.error) return res.status(400).json({ status: "error", code: r.error, message: r.message });
  res.json({ status: "success", data: r });
});

app.post(['/api/v1/wallet/skins/withdraw', '/api/v1/inventory/withdraw'], async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const tradeLink = req.body?.tradeLink || user.tradeLink;
  const r = await inventory.requestWithdraw(user.id, req.body?.ids || req.body?.id, tradeLink);
  if (r.error) return res.status(400).json({ status: "error", code: r.error, message: r.message });
  res.json({ status: "success", data: r, message: "Заявка на вывод создана" });
});

app.get('/api/v1/wallet/skins/withdrawals', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const data = await inventory.listWithdrawals(user.id);
  res.json({ status: "success", data, items: data, total: data.length });
});

app.post('/api/v1/wallet/withdrawals/:uid/cancel', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const r = await inventory.cancelWithdraw(user.id, req.params.uid);
  if (r.error) return res.status(400).json({ status: "error", code: r.error, message: r.message });
  res.json({ status: "success", data: r, message: "Заявка отменена, предметы вернулись в инвентарь" });
});

// Стим-инвентарь для пополнения скинами: нужен бот со своей сессией Steam,
// поэтому отдаём явный отказ, а не пустой список, который выглядит как «пусто».
app.get('/api/v1/wallet/skins/inventory', async (req, res) => {
  res.status(501).json({
    status: "error", code: "NOT_CONNECTED",
    message: "Пополнение скинами требует Steam-бота с торговой сессией. Он не подключён."
  });
});

// --- ЧЕСТНОСТЬ (provably fair) -----------------------------------------------

app.get(['/api/v1/fair/state', '/api/v1/fair/current'], async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  res.json({ status: "success", data: await fairness.publicState(user.id) });
});

app.post('/api/v1/fair/client-seed', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const r = await fairness.setClientSeed(user.id, req.body?.clientSeed);
  if (r.error) return res.status(400).json({ status: "error", code: r.error, message: r.message });
  res.json({ status: "success", data: r });
});

app.post('/api/v1/fair/rotate', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const r = await fairness.rotate(user.id);
  res.json({ status: "success", data: r, message: "Старый серверный сид раскрыт, выдана новая пара" });
});

app.get('/api/v1/fair/history', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  res.json({ status: "success", data: await fairness.history(user.id, 100) });
});

// Проверка доступна без авторизации: любой может пересчитать чужой бросок.
app.get(['/api/v1/fair/verify', '/api/v1/fair/check'], (req, res) => {
  const r = fairness.verify({
    serverSeed: req.query.serverSeed,
    clientSeed: req.query.clientSeed,
    nonce: req.query.nonce
  });
  if (r.error) return res.status(400).json({ status: "error", code: r.error, message: r.message });
  res.json({ status: "success", data: r });
});

// --- БАТТЛЫ -----------------------------------------------------------------

/** id текущего игрока для проверок доступа; у гостя — null. */
async function viewerIdOf(req) {
  const user = await currentUser(req, mockUser);
  return user && !user.isGuest && user.id ? String(user.id) : null;
}

app.get(['/api/v1/crate-pvp', '/api/v1/battles'], async (req, res) => {
  // viewerId нужен, чтобы создатель и участники видели свой приватный замес
  // в лобби; всем остальным приватные замесы не показываются вовсе.
  res.json({
    status: "success",
    data: await battles.list({ status: req.query.status, viewerId: await viewerIdOf(req) })
  });
});

app.get('/api/v1/battles/:uid', async (req, res) => {
  const battle = await battles.getByUid(req.params.uid, {
    withDrops: true, viewerId: await viewerIdOf(req)
  });
  if (!battle) return res.status(404).json({ status: "error", code: "NOT_FOUND", message: "Замес не найден" });
  res.json({ status: "success", data: { battle } });
});

app.post('/api/v1/battles/create', async (req, res) => {
  try {
    const user = (await currentUser(req, mockUser)) || guestUser();
    if (user.isGuest) {
      return res.status(401).json({ status: "error", code: "UNAUTHORIZED", message: "Нужна авторизация" });
    }

    const body = req.body || {};
    const rawCases = body.caseIds || body.cases || body.caseSlugs || [];
    const caseSlugs = (Array.isArray(rawCases) ? rawCases : [rawCases])
      .map(c => String(typeof c === 'object' ? (c.slug || c.id) : c)).filter(Boolean);
    if (!caseSlugs.length) {
      return res.status(400).json({ status: "error", code: "NO_CASES", message: "Не выбран ни один кейс" });
    }

    const rounds = Math.min(Math.max(parseInt(body.rounds) || 1, 1), 10);
    const maxPlayers = [2, 3, 4].includes(Number(body.maxPlayers || body.players))
      ? Number(body.maxPlayers || body.players) : 2;

    // Цена входа — сумма выбранных кейсов, умноженная на число раундов.
    const loaded = await battles.loadCases(caseSlugs);
    if (!loaded.length) {
      return res.status(400).json({ status: "error", code: "NO_CASES", message: "Кейсы не найдены" });
    }
    const price = loaded.reduce((a, c) => a + (Number(c.row.price) || 0), 0) * rounds;

    const balance = await getBalance(req, mockUser);
    if (balance < price) {
      return res.status(400).json({
        status: "error", code: "INSUFFICIENT_BALANCE",
        message: `Недостаточно средств: нужно ${price} ₽, на балансе ${balance} ₽`
      });
    }
    await adjustBalance(req, mockUser, -price);
    await recordTransaction(req, 'battle_entry', -price, `Создание замеса на ${caseSlugs.length} кейс(ов)`);

    const created = await battles.create({
      user, caseSlugs, rounds, maxPlayers, isPrivate: !!body.isPrivate, price
    });
    if (!created) {
      await adjustBalance(req, mockUser, price);   // не смогли создать — вернули деньги
      return res.status(500).json({ status: "error", message: "Не удалось создать замес" });
    }
    // Для приватного замеса ссылка — единственный вход, поэтому отдаём её
    // сразу: в лобби такой замес никому, кроме участников, не показывается.
    res.json({
      status: "success",
      data: {
        battleId: created.uid, uid: created.uid, price,
        isPrivate: created.isPrivate,
        link: `${PUBLIC_URL}/crate-pvp/${created.uid}`
      }
    });
  } catch (e) {
    console.error('POST /battles/create:', e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

/** Общий вход: живой игрок или бот. */
async function joinBattle(req, res, asBot) {
  try {
    const uid = req.params.uid || req.params.id;
    const user = (await currentUser(req, mockUser)) || guestUser();
    if (!asBot && user.isGuest) {
      return res.status(401).json({ status: "error", code: "UNAUTHORIZED", message: "Нужна авторизация" });
    }

    const viewerId = user && !user.isGuest && user.id ? String(user.id) : null;
    const info = await battles.getByUid(uid, { viewerId });
    if (!info) return res.status(404).json({ status: "error", code: "NOT_FOUND", message: "Замес не найден" });

    if (!asBot) {
      const balance = await getBalance(req, mockUser);
      if (balance < info.totalPrice) {
        return res.status(400).json({
          status: "error", code: "INSUFFICIENT_BALANCE",
          message: `Недостаточно средств: нужно ${info.totalPrice} ₽`
        });
      }
    }

    const joined = await battles.join({ uid, user, asBot, viewerId });
    if (joined.error) {
      const code = joined.error === 'NOT_FOUND' ? 404 : joined.error === 'FORBIDDEN' ? 403 : 409;
      return res.status(code).json({ status: "error", code: joined.error, message: joined.message });
    }

    if (!asBot) {
      await adjustBalance(req, mockUser, -info.totalPrice);
      await recordTransaction(req, 'battle_entry', -info.totalPrice, `Вход в замес ${uid}`);
    }

    let result = null;
    if (joined.full) {
      result = await battles.play(joined.battleDbId);
      // Банк победителям. Боты ничего не получают — их доля остаётся у площадки.
      for (const w of (result?.winners || [])) {
        if (!w.isBot) await adjustBalanceById(w.userId, w.share, 'battle_win', `Победа в замесе ${uid}`);
      }
    }

    const battle = await battles.getByUid(uid, { withDrops: true, viewerId });
    res.json({ status: "success", data: { success: true, battle, result } });
  } catch (e) {
    console.error('POST /battles/join:', e);
    res.status(500).json({ status: "error", message: e.message });
  }
}

app.post(['/api/v1/battles/:uid/join'], (req, res) => joinBattle(req, res, false));
app.post(['/api/v1/battles/:uid/add-bot'], (req, res) => joinBattle(req, res, true));

app.post('/api/v1/battles/:uid/recreate', async (req, res) => {
  const src = await battles.getByUid(req.params.uid, { viewerId: await viewerIdOf(req) });
  if (!src) return res.status(404).json({ status: "error", code: "NOT_FOUND", message: "Замес не найден" });
  req.body = {
    caseIds: src.cases.map(c => c.slug),
    rounds: src.rounds,
    maxPlayers: src.maxPlayers,
    isPrivate: src.isPrivate
  };
  app._router.handle(Object.assign(req, { url: '/api/v1/battles/create', method: 'POST' }), res, () => {});
});

// --- РОЗЫГРЫШИ ---------------------------------------------------------------

app.get('/api/v1/giveaways/active-mega', async (req, res) => {
  res.json({ status: "success", data: await giveaways.activeMega() });
});

app.get('/api/v1/giveaways/history', async (req, res) => {
  res.json({ status: "success", data: await giveaways.history() });
});

app.get(['/api/v1/giveaway', '/api/v1/giveaways'], async (req, res) => {
  res.json({ status: "success", data: await giveaways.list({ status: req.query.status || 'active' }) });
});

app.get('/api/v1/giveaways/:uid/participants', async (req, res) => {
  res.json({ status: "success", data: await giveaways.participants(req.params.uid) });
});

app.post(['/api/v1/giveaways/:uid/join', '/api/v1/giveaway/:uid/join'], async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  let depositTotal = 0;
  if (req.auth && !req.auth.mock) {
    await ensureTxSchema();
    const rows = await queryAdminDb(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND type = 'deposit'`,
      [req.auth.sub]);
    depositTotal = rows.length ? Number(rows[0].s) || 0 : 0;
  }
  const r = await giveaways.join({ uid: req.params.uid, user, depositTotal });
  if (r.error) {
    const code = r.error === 'UNAUTHORIZED' ? 401 : r.error === 'NOT_FOUND' ? 404 : 409;
    return res.status(code).json({ status: "error", code: r.error, message: r.message });
  }
  res.json({ status: "success", data: r, message: "Вы участвуете в розыгрыше" });
});

app.get(['/api/v1/wallet', '/api/v1/wallet/config'], async (req, res) => {
  const balance = await getBalance(req, mockUser);
  // Методы оплаты и лимиты — из таблиц админки, а не из констант.
  const wallet = await cached('siteWallet', 30000, async () => {
    const methods = await queryAdminDb(
      `SELECT code, name, icon, kind, min_amount, max_amount, fee_percent
       FROM wallet_methods WHERE enabled = 1 ORDER BY kind ASC, position ASC`);
    const presets = await queryAdminDb(
      `SELECT amount, bonus_percent FROM deposit_presets WHERE enabled = 1 ORDER BY position ASC`);
    const limits = await adminSetting('wallet_config', {});
    return { methods, presets, limits };
  });
  if (wallet.methods.length) {
    return res.json({
      status: "success",
      data: {
        balance, currency: "RUB",
        paymentMethods: wallet.methods
          .filter(m => m.kind === 'deposit')
          .map(m => ({ id: m.code, name: m.name, icon: m.icon, min: m.min_amount, max: m.max_amount, feePercent: m.fee_percent })),
        withdrawMethods: wallet.methods
          .filter(m => m.kind === 'withdraw')
          .map(m => ({ id: m.code, name: m.name, icon: m.icon, min: m.min_amount, max: m.max_amount, feePercent: m.fee_percent })),
        depositPresets: wallet.presets.map(p => ({ amount: p.amount, bonusPercent: p.bonus_percent })),
        minDeposit: wallet.limits.minDeposit ?? 100,
        maxDeposit: wallet.limits.maxDeposit ?? 150000,
        minWithdraw: wallet.limits.minWithdraw ?? 500
      }
    });
  }
  res.json({
    status: "success",
    data: {
      balance,
      currency: "RUB",
      paymentMethods: [
        { id: "card", name: "Банковская карта RUB", icon: "/assets/wallet/pm-cards.svg" },
        { id: "sbp", name: "СБП", icon: "/assets/wallet/sbp.svg" },
        { id: "crypto", name: "Криптовалюта (USDT / TON / BTC)", icon: "/assets/wallet/pm-crypto.svg" }
      ]
    }
  });
});

app.get('/api/v1/wallet/transactions', async (req, res) => {
  if (!req.auth || req.auth.mock) return res.json({ status: 'success', data: [] });
  await ensureTxSchema();
  const rows = await queryAdminDb(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100',
    [req.auth.sub]);
  res.json({
    status: 'success',
    data: rows.map(r => ({
      id: 'tx-' + r.id,
      type: r.type,
      amount: r.amount,
      comment: r.comment || '',
      status: 'completed',
      date: r.created_at
    }))
  });
});

app.post(['/api/v1/wallet/deposit/card', '/api/v1/wallet/deposit'], async (req, res) => {
  const amount = Math.round(Number(req.body.amount) || 500);
  if (amount <= 0 || amount > 500000) {
    return res.status(400).json({ status: 'error', message: 'Некорректная сумма пополнения' });
  }
  // Платёжного провайдера нет — зачисляем сразу. Реальная интеграция должна
  // зачислять только по вебхуку об успешной оплате.
  const newBalance = await adjustBalance(req, mockUser, amount);
  await recordTransaction(req, 'deposit', amount, 'Пополнение картой');
  res.json({
    status: 'success',
    data: {
      url: `${PUBLIC_URL}/wallet`,
      newBalance,
      balance: newBalance,
      message: `Пополнение на ${amount} ₽ прошло успешно`
    }
  });
});

app.post('/api/v1/wallet/withdraw', async (req, res) => {
  const amount = Math.round(Number(req.body.amount) || 0);
  if (amount <= 0) return res.status(400).json({ status: 'error', message: 'Некорректная сумма вывода' });
  const balance = await getBalance(req, mockUser);
  if (balance < amount) {
    return res.status(400).json({ status: 'error', code: 'INSUFFICIENT_BALANCE',
      message: `Недостаточно средств: на балансе ${balance} ₽` });
  }
  const newBalance = await adjustBalance(req, mockUser, -amount);
  await recordTransaction(req, 'withdraw', -amount, 'Заявка на вывод');
  if (req.auth && !req.auth.mock) {
    await new Promise((resolve) => {
      const db = getAdminDb(); if (!db) return resolve();
      db.run(`INSERT INTO withdrawals (user_id, amount, currency, status) VALUES (?, ?, 'RUB', 'pending')`,
        [req.auth.sub, amount], () => { db.close(); resolve(); });
    });
  }
  res.json({ status: 'success', data: { newBalance, balance: newBalance }, message: 'Заявка на вывод создана' });
});

// Wildcard API fallback
app.use('/api/v1', (req, res) => {
  res.json({ status: "success", data: [] });
});

// --- MEDIA & STATIC ASSETS ROUTES ---

// Audio & Sound Effects Directory
app.use('/audio', express.static(path.join(PUBLIC_DIR, 'audio'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp3')) res.setHeader('Content-Type', 'audio/mpeg');
    if (filePath.endsWith('.ogg')) res.setHeader('Content-Type', 'audio/ogg');
    if (filePath.endsWith('.wav')) res.setHeader('Content-Type', 'audio/wav');
  }
}));

app.use('/sounds', express.static(path.join(PUBLIC_DIR, 'sounds')));

// Steam Avatars
app.use('/avatars.steamstatic.com', express.static(path.join(PUBLIC_DIR, 'avatars')));
app.use('/avatars', express.static(path.join(PUBLIC_DIR, 'avatars')));

// Subdirectory asset routes
app.use('/icons', express.static(path.join(PUBLIC_DIR, 'icons')));
app.use('/png', express.static(path.join(PUBLIC_DIR, 'png')));
app.use('/svg', express.static(path.join(PUBLIC_DIR, 'svg')));
app.use('/image', express.static(path.join(PUBLIC_DIR, 'image')));
app.use('/packs', express.static(path.join(PUBLIC_DIR, 'packs')));
app.use('/uploads', express.static(path.join(PUBLIC_DIR, 'uploads')));

// Main assets directory
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Static root files with known extensions only
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const ext = path.extname(req.path);
  if (ext && ext !== '.html') {
    return express.static(PUBLIC_DIR, { fallthrough: true, index: false })(req, res, next);
  }
  next();
});

// SPA History Fallback (Return index.html with text/html header)
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

// Server instance
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'connected', data: { status: 'online' } }));
  ws.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.action === 'auth' || parsed.event === 'auth') {
        // Токен приходит от того же access-JWT, что и в Authorization-заголовке.
        const payload = verifyJWT(parsed.token || parsed.data?.token);
        const user = payload && !payload.mock
          ? await currentUser({ auth: payload }, mockUser)
          : (ALLOW_MOCK_AUTH ? mockUser : null);
        ws.send(JSON.stringify(
          user
            ? { event: 'authenticated', data: { user } }
            : { event: 'unauthorized', data: {} }
        ));
      }
    } catch(e) {}
  });
});

server.listen(PORT, async () => {
  await ensureAuthSchema();
  await verifyMailer();
  await battles.ensureSchema();
  await giveaways.seedIfEmpty();
  giveaways.startTimer();

  // Чистим связи кейсов, ведущие на удалённые предметы, и предупреждаем о
  // кейсах, которые в текущем виде открывать нельзя.
  await cleanDanglingCaseItems();
  const broken = await getBrokenCases();
  if (broken.length) {
    console.warn(`[Cases] Настроены неверно: ${broken.length} из открытых кейсов`);
    broken.forEach(c => console.warn(`   • ${c.slug} (${c.price} ₽): ${c.problems.join('; ')}`));
    console.warn(`   Открытие таких кейсов блокируется. Состав правится в админке.`);
  }


  // Фоновый обход каталога Steam. Отключается STEAM_CATALOG_SYNC=0.
  const catalogEnabled = process.env.STEAM_CATALOG_SYNC !== '0';
  if (catalogEnabled) {
    const db = openCatalogDb();
    if (db) { await ensureCatalogSchema(db); db.close(); }
    startCatalogWorker();
  }

  console.log(`================================================`);
  console.log(` NewCasesRust WebSocket & SPA Server at: http://localhost:${PORT}`);
  console.log(` Public URL (Steam realm):  ${PUBLIC_URL}`);
  console.log(` Steam return_to:           ${PUBLIC_URL}/api/v1/auth/steam/return`);
  console.log(` Admin DB Connected: ${ADMIN_DB_PATH}`);
  console.log(` WebSocket /ws Active on Port ${PORT}`);
  console.log(` Каталог Steam: ${catalogEnabled
    ? `обход включён (${CATALOG_PAGE_SIZE} поз./запрос, интервал ${CATALOG_INTERVAL_MS} мс)`
    : 'выключен (STEAM_CATALOG_SYNC=0)'}`);
  if (ALLOW_MOCK_AUTH) {
    console.log(` [!] ALLOW_MOCK_AUTH включён — без токена отдаётся моковый профиль.`);
    console.log(`     В проде запускать с NODE_ENV=production.`);
  }
  console.log(`================================================`);
});
