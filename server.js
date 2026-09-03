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
  REQUEST_INTERVAL_MS: CATALOG_INTERVAL_MS,
  // Нужны обновлению цен из steamdataapi: там те же центы USD и тот же курс.
  refreshFxRate,
  usdCentsToRub
} = require('./services/steamCatalog');
const {
  buildDistribution, rollOne, pickByRoll, newServerSeed, chancesForDisplay, fairFloat, DEFAULT_RTP
} = require('./services/drops');
const { cleanDanglingCaseItems, getCaseHealth, getBrokenCases, MAX_RTP } = require('./services/caseHealth');
const { verifyMailer } = require('./services/mailer');
const { makeBattlesService } = require('./services/battles');
const { makeDepositsService } = require('./services/deposits');
const { makeWalletConfig } = require('./services/walletConfig');
const rustTm = require('./services/rustTm');
const { makeRatesService } = require('./services/rates');

// Как часто тянуть цены. 0 — не обновлять автоматически, только вручную
// через deploy/prices.js.
const PRICE_REFRESH_MS = Number(process.env.PRICE_REFRESH_MS || 30 * 60 * 1000);
const rollypay = require('./services/rollypay');
const { makeGiveawaysService } = require('./services/giveaways');
const { makeInventoryService } = require('./services/inventory');
const { makeFairnessService } = require('./services/fairness');

// --- Баланс ------------------------------------------------------------------
// Авторизованному пишем в users.balance, гостю — в mockUser (в памяти).
// Это убирает прежнее поведение, когда баланс жил только в памяти процесса и
// сбрасывался при каждом рестарте.

/**
 * Баланс игрока в рублях, либо null — если он неизвестен.
 *
 * null возвращается для АВТОРИЗОВАННОГО игрока, когда базу прочитать не
 * удалось или строки пользователя в ней нет. Раньше в обоих случаях
 * подставлялся баланс мокового пользователя (5420.50), потому что
 * queryAdminDb при ошибке отдаёт пустой массив, а пустой массив неотличим
 * от «ничего не нашлось».
 *
 * На повреждённой базе это выливалось в выдачу несуществующих денег: игрок
 * видел 5420 рублей и играл на них, а запись обратно молча не проходила.
 *
 * Заглушка осталась там, где она и задумана: гость и моковый режим.
 */
async function getBalance(req, mockUser) {
  if (req.auth && !req.auth.mock) {
    const rows = await queryAdminDb(`SELECT balance FROM users WHERE id = ?`, [req.auth.sub]);
    if (rows.failed) return null;
    if (!rows.length) return null;
    return Number(rows[0].balance) || 0;
  }

  /*
   * Сюда попадает и гость: attachAuth ставит req.auth = verifyJWT(token), и
   * без действующего токена это null — то есть НЕ «моковый режим», а просто
   * неавторизованный посетитель.
   *
   * Раньше и ему отдавался моковый баланс 5420.50. В разработке это удобно, в
   * бою — раздача несуществующих денег любому, кто открыл сайт без входа:
   * баланс показывался, ставки принимались, а списывать было нечего.
   *
   * Моковые деньги остаются только там, где моковый режим включён осознанно.
   * ALLOW_MOCK_AUTH истинен при ALLOW_MOCK_AUTH=1 ИЛИ когда NODE_ENV не
   * равен production — второе условие и делает забытый NODE_ENV опасным.
   */
  if (!ALLOW_MOCK_AUTH) return 0;
  return Number(mockUser.balance) || 0;
}

/**
 * Баланс для денежной операции. Вернул null — операцию проводить нельзя,
 * ответ клиенту уже отправлен.
 *
 * Отдельная обёртка нужна, чтобы ни одна игра не начиналась с неизвестного
 * баланса: отказать в ставке неприятно, но несравнимо лучше, чем провести
 * её на выдуманные деньги.
 */
async function balanceForSpending(req, res, mockUser) {
  const balance = await getBalance(req, mockUser);
  if (balance === null) {
    console.error('[Баланс] Не прочитан для пользователя'
                + ` ${req.auth && req.auth.sub}: операция отклонена`);
    res.status(503).json({
      status: "error",
      code: "BALANCE_UNAVAILABLE",
      message: "Баланс сейчас недоступен. Попробуйте через минуту."
    });
    return null;
  }
  return balance;
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
  /*
   * Неизвестный баланс изменять нельзя: current + delta дало бы NaN, а
   * попытка «починить» его нулём списала бы игроку весь счёт. Вызывающий код
   * обязан был проверить баланс заранее через balanceForSpending.
   */
  if (current === null) {
    throw Object.assign(new Error('Баланс недоступен'), { code: 'BALANCE_UNAVAILABLE' });
  }
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

/*
 * Пометка «этот ответ не класть в кэш». Нужна для аварийных путей: сбой базы
 * на миллисекунду не должен фиксировать сломанный ответ на весь TTL.
 */
const _noCache = new WeakSet();
function NO_CACHE(value) {
  if (value && typeof value === 'object') _noCache.add(value);
  return value;
}

async function cached(key, ttlMs, producer) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await producer();
  if (_noCache.has(value)) return value;
  _cache.set(key, { at: Date.now(), value });
  if (_cache.size > 500) {                       // простая защита от разрастания
    const oldest = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
  return value;
}

/*
 * Ошибка в async-обработчике express не доходит до next(), поэтому
 * превращается в необработанный отказ промиса, а Node 20 на таком отказе
 * завершает процесс. Так один запрос к избранному укладывал весь сайт, и pm2
 * поднимал его по кругу — 242 перезапуска подряд.
 *
 * Логируем и продолжаем работать. Это страховка, а не замена исправлениям:
 * каждая такая запись в логе — настоящая ошибка, её надо чинить.
 *
 * uncaughtException оставлен фатальным намеренно: после него состояние
 * процесса не восстановить, и pm2 честнее перезапустить.
 */
process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[Отказ без обработчика]', e.stack || e.message);
});

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
// Сырое тело сохраняем рядом с разобранным: подпись вебхука RollyPay считается
// от тела ДО разбора, и JSON.stringify(req.body) её уже не воспроизведёт —
// порядок ключей и пробелы после парсинга не те.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

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
    const db = new sqlite3.Database(ADMIN_DB_PATH);
    /*
     * Без таймаута любой SELECT, попавший на запись обхода Steam, немедленно
     * получает SQLITE_BUSY. Дальше ошибка превращалась в пустой результат, и
     * каталог из 5400 предметов подменялся аварийным списком из трёх — именно
     * поэтому лента показывала одно и то же. Пять секунд ожидания дешевле.
     */
    db.configure('busyTimeout', 5000);
    return db;
  }
  return null;
}

/*
 * Возвращает строки. При ошибке — пустой массив, но с записью в лог и с
 * пометкой `failed`, чтобы вызывающий мог отличить «база не ответила» от
 * «в таблице пусто». Раньше эти два случая были неразличимы, и сбой базы
 * молча деградировал в подстановку заглушек.
 */
function queryAdminDb(sql, params = []) {
  return new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) {
      const empty = [];
      empty.failed = true;
      return resolve(empty);
    }
    db.all(sql, params, (err, rows) => {
      db.close();
      if (err) {
        console.error(`[DB] ${err.code || 'ERROR'}: ${err.message} | ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 90)}`);
        const empty = [];
        empty.failed = true;
        return resolve(empty);
      }
      resolve(rows || []);
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
  if (!rows.failed && rows.length === 0) {
    rows = await queryAdminDb(`SELECT * FROM items ORDER BY price DESC`);
  }
  /*
   * База не ответила — это не «каталог пуст». Отдаём то, что уже лежит в кэше,
   * пусть и просроченное: показать вчерашние цены честнее, чем подменить весь
   * каталог тремя заглушками. И такой ответ кэшировать нельзя, иначе сбой
   * длиной в миллисекунду держал бы ленту сломанной полминуты.
   */
  if (rows.failed) {
    const stale = _cache.get('liveItems');
    if (stale && Array.isArray(stale.value) && stale.value.length) {
      console.error('[Каталог] База не ответила, отдаю прошлый результат');
      return NO_CACHE(stale.value);
    }
    console.error('[Каталог] База не ответила и кэш пуст, отдаю аварийный список');
  }
  if (rows && rows.length > 0) {
    return rows.filter(r => !r.admin_disabled).map(r => ({
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
  
  // Локальный слепок каталога, если он есть.
  if (fs.existsSync(SKINS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SKINS_FILE, 'utf8'));
      if (data.skins && data.skins.length > 0) return data.skins;
    } catch (e) {}
  }

  /*
   * Дальше зашитого списка НЕТ, и это осознанно.
   *
   * Раньше здесь возвращались три предмета прямо из кода, с картинками
   * /assets/header/logo.webp и battles/*.png. Задумка была «пусть лента не
   * пустует», но получалось хуже пустоты: в ленте по кругу «выпадал» логотип
   * сайта с ценой 350, и со стороны это выглядело поломкой вёрстки, а не
   * отсутствием данных. Настоящую причину по такой картинке не найти.
   *
   * Пустая лента однозначна: данных нет, и в логе написано почему.
   */
  warnEmptyCatalog();
  return [];
}

/*
 * Сообщение о пустом каталоге, но не чаще раза в пять минут: getLiveItems
 * зовётся почти из каждого игрового эндпоинта, и без ограничения лог
 * превратился бы в сплошную стену.
 */
let emptyCatalogWarnedAt = 0;
function warnEmptyCatalog() {
  const now = Date.now();
  if (now - emptyCatalogWarnedAt < 5 * 60 * 1000) return;
  emptyCatalogWarnedAt = now;
  console.error('[Каталог] ПУСТО: предметов нет ни в базе, ни в локальном слепке.');
  console.error('[Каталог] Лента и кейсы останутся пустыми, пока каталог не наполнится.');
  console.error('[Каталог] Наполнить: node deploy/seed-catalog.js --apply');
}

// Get live series / categories from Admin DB with non-empty cases filtering
async function getLiveSeries() {
  const dbSeries = await queryAdminDb(`SELECT * FROM series WHERE status = 'active' ORDER BY id ASC`);
  const dbCases = await queryAdminDb(`SELECT c.* FROM cases c LEFT JOIN series s ON s.id=c.seriesId
    WHERE c.archived = 0 AND c.isActive = 1 AND c.status = 'active'
      AND (c.seriesId IS NULL OR s.status = 'active') ORDER BY c.sortOrder ASC`);
  const items = await getLiveItems();

  /*
   * Состав кейсов — одним запросом на все кейсы сразу.
   *
   * Здесь раньше каждому кейсу подставлялось `items.slice(0, 10)` — голова
   * общего каталога, отсортированного по цене. То есть все кейсы показывали
   * один и тот же десяток самых дорогих предметов, а лента выпадений, которая
   * берёт предметы отсюда, повторяла одно и то же. Настоящий состав всё это
   * время лежал в case_items и не читался.
   *
   * Запрос один на все кейсы, а не по одному на кейс: getAdminDb открывает под
   * каждый вызов отдельное соединение, а getLiveSeries дёргается с главной.
   */
  const composition = new Map();
  const compRows = await queryAdminDb(`
    SELECT ci.case_id, ci.item_id, ci.chance,
           i.name, i.price, i.image, i.rarity, i.color, i.market_hash_name
    FROM case_items ci
    JOIN items i ON i.id = ci.item_id
    WHERE i.delisted = 0 OR i.delisted IS NULL
    ORDER BY ci.case_id ASC, i.price DESC
  `);
  for (const r of compRows) {
    if (!composition.has(r.case_id)) composition.set(r.case_id, []);
    composition.get(r.case_id).push({
      id: `db-${r.item_id}`,
      name: r.name || r.market_hash_name,
      marketHashName: r.market_hash_name,
      price: r.price || 100,
      priceText: `${r.price || 100} ₽`,
      image: fixImageUrl(r.image),
      rarity: (r.rarity || 'rare').toLowerCase(),
      colorHex: r.color ? (String(r.color).startsWith('#') ? r.color : `#${r.color}`) : '#35a3f1',
      chance: Number(r.chance) || 0
    });
  }

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
      // Пустой состав остаётся пустым: предметы других кейсов не подставляем.
      items: composition.get(c.id) || []
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

  // A successful empty result must not resurrect demo cases.
  if (seriesList.length === 0 && dbCases.failed) {
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
  if (dbBanners && !dbBanners.failed) {
    // Пустая выборка — все баннеры отключены, а не повод показывать демо.
    return dbBanners.map(require('./services/bannerContent').publicBanner);
  }

  return [
    {
      id: "banner-tiktok",
      title: "Делай нарезки\nлутай ещё больше",
      description: "Конкурс моментов в тиктоке",
      buttonText: "Участвовать",
      buttonColor: "#f36a21",
      buttonAction: "url",
      buttonValue: "/giveaway",
      glowColor: "#f36a21",
      borderColor: "#754325",
      background: "radial-gradient(ellipse at 80% 50%, #2a1409 0%, #0b0a08 100%)",
      image: "/assets/battles/winner-boar.png",
      video: null
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
  username: "Satchel_Dev",
  name: "Satchel_Dev",
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

// Заявки на пополнение. Начисление живёт только внутри confirm() — так деньги
// не могут появиться в обход подтверждения.
const deposits = makeDepositsService({ queryAdminDb, getAdminDb, adjustBalanceById });
const depositLadder = require('./services/depositLadder').makeDepositLadder({ queryAdminDb, getAdminDb });
const walletConfig = makeWalletConfig({ queryAdminDb, adminSetting });
// Курсы валют кошелька. Обновляются сами: строки source='manual' не трогаются.
const rates = makeRatesService({ queryAdminDb, getAdminDb, rollypay });
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
  // Первым здесь стояло имя прежнего бренда — осталось от Kaban.
  'Фитиль', 'RustLord', 'Шрам', 'Тихий', 'Барсук', 'Никита', 'Волк', 'Прапор',
  'Сталкер', 'Мясник', 'Хантер', 'Гоша', 'Рейдер', 'Пепел', 'Тайга'
];

/**
 * eventType у нас в верхнем регистре, а карточка ленты читает `gameType`
 * строчными — и по нему решает, куда вести по клику:
 *
 *   switch (drop.gameType) {
 *     case 'case':        push({name:'case', params:{slug: drop.caseSlug}})
 *     case 'cratebattle': push({name:'crate-pvp-battle', params:{uid: drop.battleId}})
 *     case 'upgrader':    push({name:'upgrader'})
 *   }
 *
 * Поля `gameType` сервер не отдавал вовсе, поэтому switch не совпадал ни с
 * чем и клик по карточке молчал.
 */
const GAME_TYPE = { CASE: 'case', BATTLE: 'cratebattle', CRATEBATTLE: 'cratebattle', UPGRADER: 'upgrader' };

function makeWin({ item, user, eventType = 'CASE', caseSlug = '', caseName = '', caseImage = null,
                   battleId = null, betAmount = 0, multiplier = 1, wonAt }) {
  const value = Number(item.price) || 0;
  return {
    sourceEventId: `${eventType}-${wonAt}-${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id ?? 0,
    userName: user.name,
    avatarUrl: user.avatar || mockAvatar,
    steamLevel: user.steamLevel ?? 0,
    wonAt,
    eventType,
    // Строчный вариант для карточки. Без него не работают ни клик, ни переход.
    gameType: GAME_TYPE[String(eventType).toUpperCase()] || 'case',
    itemName: item.name,
    itemImage: fixImageUrl(item.image),
    itemValue: value,
    betAmount,
    winAmount: value,
    multiplier,
    isBigWin: value >= 5000,
    caseImage,
    caseSlug,
    // Название кейса показывается при наведении. Его сервер тоже не отдавал.
    caseName,
    battleId,
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

  // Синтетику привязываем к НАСТОЯЩИМ кейсам. Без этого у карточки нет ни
  // картинки кейса, ни названия для подсказки, а клик ведёт в никуда —
  // а синтетика заполняет почти всю ленту, пока игроков мало.
  const cases = (await getLiveCases()).filter(c => c.slug);

  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (let i = 0; i < LIVE_FEED_MAX; i++) {
    const item = pick();
    const eventType = i % 9 === 0 ? 'UPGRADER' : i % 5 === 0 ? 'BATTLE' : 'CASE';
    // Кейс нужен только выпадению из кейса: у апгрейдера и баттла свои
    // страницы, и подсовывать им кейс было бы враньём.
    const c = eventType === 'CASE' && cases.length
      ? cases[Math.floor(Math.random() * cases.length)]
      : null;

    out.push(makeWin({
      item,
      user: { id: 1000 + i, name: FEED_NAMES[i % FEED_NAMES.length] + (i % 7 ? '' : '_' + (10 + i)), avatar: mockAvatar, steamLevel: (i * 7) % 60 },
      eventType,
      caseSlug: c ? c.slug : '',
      caseName: c ? c.name : '',
      caseImage: c ? c.image : null,
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
  /*
   * Здесь тоже нет зашитого списка, и по той же причине.
   *
   * Подставлять выдуманные предметы в кейс опаснее, чем в ленту: игрок
   * получил бы в приз логотип сайта, и это списалось бы ему как выигрыш.
   *
   * Пустой список безопасен: открытие кейса проверяет состав до того, как
   * тронуть деньги, и при нуле предметов возвращает 409 CASE_MISCONFIGURED
   * с текстом «В кейсе нет доступных предметов. Проверьте состав в админке».
   */
  return [];
}

require('./services/gameAccess').register({ app, queryAdminDb });
require('./services/wagerGuard').register({ app, deposits });
app.post(['/api/v1/cases/open', '/api/v1/cases/:slug/open'], async (req, res) => {
  try {
    const slug = req.body.slug || req.params.slug || 'limit';
    const quantity = parseInt(req.body.quantity || req.body.count || 1) || 1;

    const dbCases = await queryAdminDb(`SELECT * FROM cases WHERE slug = ? OR id = ?`, [slug, slug]);
    const c = dbCases[0];
    if (!c) return res.status(404).json({status:'error',code:'CASE_NOT_FOUND',message:'Кейс не найден'});
    const series = c.seriesId ? (await queryAdminDb('SELECT status FROM series WHERE id=?',[c.seriesId]))[0] : null;
    if (c.isActive === 0 || c.status !== 'active' || (c.seriesId && series?.status !== 'active')) {
      return res.status(409).json({status:'error',code:'CASE_INACTIVE',message:'Кейс или его серия деактивированы'});
    }
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

    const balanceBefore = await balanceForSpending(req, res, mockUser);
    if (balanceBefore === null) return;
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
        caseName: c ? c.name : '',
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
    // Здесь деньги уже проведены, и баланс нужен только для ответа: если
    // прочитать не вышло, показываем то, что посчитали сами.
    balanceAfter = (await getBalance(req, mockUser)) ?? balanceAfter;
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

/*
 * Таблица избранного.
 *
 * Её создаёт этот сервер, а не админка: у админки своей вкладки избранного
 * нет, а фронт дёргает /user/favorites при загрузке страницы. Пока функции
 * не было, каждый такой запрос ронял процесс с ReferenceError — express не
 * ловит ошибки async-обработчиков, а Node 20 на необработанном отказе
 * завершается. Отсюда и были сотни перезапусков под pm2.
 *
 * user_id хранится строкой: идентификаторы приходят и числом, и строкой
 * SteamID, а сравнение в запросах идёт через String(user.id).
 */
let favoritesSchemaReady = false;
async function ensureFavoritesSchema() {
  if (favoritesSchemaReady) return;
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`CREATE TABLE IF NOT EXISTS user_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      case_slug TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, case_slug))`, () => { db.close(); resolve(); });
  });
  favoritesSchemaReady = true;
}

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

const TIER_FALLBACK_IMAGE = '/uploads/cases/1786522990114-495918520.webp';

/** Есть ли файл картинки на диске: в базе встречаются ссылки на удалённые загрузки. */
function imageOnDisk(img) {
  return !!(img && String(img).startsWith('/') && fs.existsSync(path.join(PUBLIC_DIR, img)));
}

/**
 * Кейс, привязанный к тиру ЯВНО настройкой админки. null — привязки нет.
 *
 * Отделено от tierCase намеренно, и это не косметика.
 *
 * Фронт определяет «этот кейс — ступень лестницы» сравнением слагов:
 *
 *   j = tierViews.find(t => t.caseSlug === слаг_открытого_кейса)
 *   isChainCase = j !== null
 *
 * А дальше кнопка открытия подменяется состоянием ступени: `locked` даёт
 * «Откройте предыдущий», `collecting` — «Пополните». Поэтому любой слаг,
 * попавший в caseSlug, отбирает у настоящего кейса кнопку открытия.
 *
 * Раньше tierCase при отсутствии привязки возвращал кейс по порядковому
 * номеру, и пять ступеней захватывали первые пять кейсов каталога. Игрок
 * забирал бесплатный кейс, следующие ступени становились locked — и на
 * обычных кейсах появлялось «Откройте предыдущий».
 */
function tierLinkedCase(tier, cases) {
  const slug = tier && (tier.slug || tier.caseSlug || tier.case);
  if (!slug) return null;
  return cases.find(c => String(c.slug) === String(slug) || String(c.id) === String(slug)) || null;
}

/**
 * Кейс тира для показа: явная привязка, иначе любой по порядку.
 *
 * Годится ТОЛЬКО для названия и картинки. Для caseSlug использовать нельзя —
 * см. tierLinkedCase.
 */
function tierCase(tier, idx, cases) {
  return tierLinkedCase(tier, cases) || cases[idx % Math.max(cases.length, 1)] || null;
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
  const claimed = new Set(req.auth && !req.auth.mock
    ? (await depositLadder.claimed(req.auth.sub)).map(row=>row.tier_index) : []);

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
    const linked = tierLinkedCase(t, cases);
    const img = tierImage(t, idx, cases);
    const label = t.name || (src && src.name) || `Кейс ${idx + 1}`;
    return {
      tierIndex: idx,
      caseName: label,
      caseImage: img,
      // Дубли под другим именем — на случай, если где-то читается name/image.
      name: label,
      image: img,
      // Только явная привязка. Кейс, взятый «по порядку» для картинки, сюда
      // попадать не должен: фронт по этому полю опознаёт ступень и отбирает
      // у настоящего кейса кнопку открытия.
      caseSlug: linked ? linked.slug : null,
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
  try {
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
  } catch(error) {
    console.error('[Deposit ladder]',error);
    res.status(503).json({status:'error',code:'CHAIN_UNAVAILABLE',message:'Не удалось загрузить состояние лестницы'});
  }
});

// Забрать бесплатный кейс тира. Фронт зовёт это из openTier().
//
// Коды ошибок читаются бандлом (index-B3loti9-.js) и должны быть ровно эти:
// CHAIN_UNAVAILABLE, CHAIN_OUT_OF_ORDER, CHAIN_INSUFFICIENT_DEPOSIT.
// Любой другой код уходит в общий тост «что-то пошло не так».
app.post('/api/v1/deposit-chain/open', async (req, res) => {
  if (!req.auth || req.auth.mock) return res.status(401).json({status:'error',code:'UNAUTHORIZED',message:'Нужна авторизация'});
  try {
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

  const value = Number(item?.price) || 0;
  const claim = await depositLadder.claim({userId:req.auth.sub,tierIndex,threshold:Number(tier.threshold),caseName:tier.caseName,item});
  if (!claim.ok) return res.status(claim.error==='CHAIN_INSUFFICIENT_DEPOSIT'?403:409).json({status:'error',code:claim.error,message:claim.message});
  const balance = claim.balance;

  const user = (await currentUser(req, mockUser)) || guestUser();
  if (item) {
    pushLiveDrop(makeWin({
      item: { name: item.name, price: value, image: item.image, rarity: item.rarity, colorHex: item.color },
      user: { id: user.id, name: user.username, avatar: user.avatar },
      eventType: 'CASE', caseSlug: src ? src.slug : '',
      caseName: tier.caseName || (src ? src.name : ''), caseImage: tier.caseImage,
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
  } catch(error) {
    console.error('[Deposit ladder]',error);
    res.status(503).json({status:'error',code:'CHAIN_UNAVAILABLE',message:'Не удалось обработать открытие. Обновите состояние лестницы перед повтором.'});
  }
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
      upgraderEnabled: true,
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
    const catalog = (await getLiveItems()).filter(item => item.upgraderEnabled);
    const byId = new Map(catalog.map(i => [String(i.id), i]));

    /*
     * Что на самом деле присылает фронт (landing-mLe--Uh6.js, store апгрейдера):
     *
     *   placeUpgrade({ itemIds: n.value.map(t => t.id), betAmount: l.value })
     *
     * itemIds — это ЦЕЛЬ, предметы, на которые игрок хочет поднять ставку.
     * betAmount — сама ставка в монетах, и приходит она СТРОКОЙ.
     * Множитель фронт нигде не шлёт: он показывает его как отношение
     * стоимости цели к ставке, ровно то, что видно на экране — 110 / 25 = x4.4.
     *
     * Раньше сервер понимал это наоборот: считал itemIds ставкой, а betAmount
     * множителем. При ставке 25 и цели за 110 выходило, что игрок ставит 110
     * и метит в 2750, — и запрос отбивался как некорректный.
     */
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds
      : (body.itemIds != null ? [body.itemIds] : []);

    const targets = itemIds.map(id => byId.get(String(id))).filter(Boolean);
    const targetFromItems = targets.reduce((a, i) => a + (Number(i.price) || 0), 0);

    // Явная цель одним полем — на случай, если её пришлют так.
    const explicitTarget = body.targetItemId != null ? byId.get(String(body.targetItemId)) : null;

    const betAmount = Math.round(Number(body.betAmount) || 0);
    let targetValue = explicitTarget ? (Number(explicitTarget.price) || 0) : targetFromItems;

    // Цели нет, но есть множитель — считаем от ставки.
    if (!(targetValue > 0) && Number.isFinite(Number(body.multiplier))) {
      const mult = Math.min(Math.max(Number(body.multiplier), UPGRADER_MIN_MULT), UPGRADER_MAX_MULT);
      targetValue = betAmount * mult;
    }

    if (!(betAmount > 0)) {
      return res.status(400).json({
        status: "error", code: "INVALID_UPGRADE", message: "Не задана ставка"
      });
    }
    if (!(targetValue > 0)) {
      return res.status(400).json({
        status: "error", code: "INVALID_UPGRADE",
        message: itemIds.length
          ? "Выбранных предметов нет в каталоге"
          : "Не выбран предмет для апгрейда"
      });
    }

    const mult = targetValue / betAmount;
    if (mult < UPGRADER_MIN_MULT) {
      return res.status(400).json({
        status: "error", code: "INVALID_MULTIPLIER",
        message: `Цель должна быть дороже ставки минимум в ${UPGRADER_MIN_MULT} раза`
      });
    }
    if (mult > UPGRADER_MAX_MULT) {
      return res.status(400).json({
        status: "error", code: "INVALID_MULTIPLIER",
        message: `Множитель больше ${UPGRADER_MAX_MULT} недоступен`
      });
    }

    // Для ответа: суммарная стоимость выбранной цели.
    const itemsValue = targetValue;

    const balanceBefore = await balanceForSpending(req, res, mockUser);
    if (balanceBefore === null) return;
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

    /*
     * Номер билета для стрелки.
     *
     * Бандл считает угол как ticket / 10000 * 360 и ЗАЖИМАЕТ его в сектор
     * исхода (landing-*.js, функция cr): выигрыш — [14, 166] градусов,
     * проигрыш — [194, 346]. Зажим, а не пересчёт: любой угол вне сектора
     * просто прилипает к его границе.
     *
     * Поэтому мало отдать билет целым числом. Если просто округлить долю до
     * 0..9999, то больше половины проигрышей дадут угол меньше 194 и стрелка
     * встанет ровно на границу — тот же эффект, только реже.
     *
     * Раскладываем бросок ВНУТРИ его сектора: считаем, какую долю сектора он
     * занял, и переводим в диапазон углов этого сектора. Стрелка ходит по
     * всему сектору, а исход по-прежнему определяет честный бросок.
     */
    const SECTOR = won ? [389, 4611] : [5389, 9611];
    const span = won ? chance : 1 - chance;
    const within = span > 0
      ? Math.min(1, Math.max(0, (won ? ticket : ticket - chance) / span))
      : 0;
    const displayTicket = Math.round(SECTOR[0] + within * (SECTOR[1] - SECTOR[0]));

    // Предмет-цель: ближайший по стоимости из каталога, а не skins[0].
    // Цель выбрана игроком — её и показываем, а не «похожую по цене».
    let bestItem = explicitTarget
      || targets.slice().sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0))[0]
      || null;
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
        // Номер билета для стрелки, разложенный по сектору исхода — см.
        // выше. ticketFloat рядом: по нему проверяется честность броска.
        ticket: displayTicket,
        ticketFloat: +ticket.toFixed(6),
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

    const balance = await balanceForSpending(req, res, mockUser);
    if (balance === null) return;
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
      const balance = await balanceForSpending(req, res, mockUser);
      if (balance === null) return;
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
  // Показ, а не трата: неизвестный баланс показываем нулём, не заглушкой.
  const balance = (await getBalance(req, mockUser)) ?? 0;
  // Форма ответа снята со стора кошелька в бандле, см. services/walletConfig.js.
  // Прежняя форма фронтом не читалась вовсе: список стран выходил пустым, а под
  // ним висело «Для выбранной страны нет доступных способов пополнения».
  const cfg = await cached(`walletCfg:${req.query.country || ''}`, 30000,
    () => walletConfig.build({ country: req.query.country }));
  res.json({ status: "success", data: { ...cfg, balance } });
});

/**
 * Кошельки игрока для вывода в крипте.
 *
 * Вкладка «Вывод» без этих трёх ручек не рисуется: список уходит в catch-all,
 * который отдаёт 200 и пустоту, и экран остаётся чёрным.
 * Монета и сеть определяются по самому адресу — так же, как это подписано
 * в интерфейсе: «кошелёк сам определяет монету и сеть».
 */
function detectAsset(address) {
  const a = String(address || '').trim();
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return { asset: 'USDT', network: 'TRC-20' };
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) return { asset: 'ETH', network: 'ERC-20' };
  if (/^(ltc1|[LM])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(a)) return { asset: 'LTC', network: 'Litecoin' };
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(a)) return { asset: 'BTC', network: 'Bitcoin' };
  return null;
}

async function ensureWalletsSchema() {
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`CREATE TABLE IF NOT EXISTS user_crypto_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      label TEXT,
      address TEXT,
      asset TEXT,
      network TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, () => { db.close(); resolve(); });
  });
}

app.get('/api/v1/wallet/crypto-wallets', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) return res.json({ status: 'success', data: [] });
  await ensureWalletsSchema();
  const rows = await queryAdminDb(
    `SELECT id, label, address, asset, network, created_at FROM user_crypto_wallets
      WHERE user_id = ? ORDER BY id DESC`, [user.id]);
  res.json({ status: 'success', data: rows });
});

app.post('/api/v1/wallet/crypto-wallets', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'Нужна авторизация' });
  }
  const address = String(req.body?.address || '').trim();
  const detected = detectAsset(address);
  if (!detected) {
    return res.status(400).json({
      status: 'error', code: 'BAD_ADDRESS',
      message: 'Не удалось определить монету по адресу. Поддерживаются USDT (TRC-20), ETH, LTC и BTC'
    });
  }
  await ensureWalletsSchema();
  const dup = await queryAdminDb(
    `SELECT id FROM user_crypto_wallets WHERE user_id = ? AND address = ?`, [user.id, address]);
  if (dup.length) {
    return res.status(409).json({ status: 'error', code: 'DUPLICATE', message: 'Такой кошелёк уже добавлен' });
  }

  const label = String(req.body?.label || '').trim() || `${detected.asset} ${address.slice(0, 6)}…${address.slice(-4)}`;
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`INSERT INTO user_crypto_wallets (user_id, label, address, asset, network) VALUES (?, ?, ?, ?, ?)`,
      [user.id, label, address, detected.asset, detected.network], () => { db.close(); resolve(); });
  });
  const rows = await queryAdminDb(
    `SELECT id, label, address, asset, network, created_at FROM user_crypto_wallets
      WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [user.id]);
  res.json({ status: 'success', data: rows[0] || null });
});

app.delete('/api/v1/wallet/crypto-wallets/:id', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'Нужна авторизация' });
  }
  await ensureWalletsSchema();
  // user_id в условии обязателен: иначе чужой кошелёк удалялся бы по номеру.
  await new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve();
    db.run(`DELETE FROM user_crypto_wallets WHERE id = ? AND user_id = ?`,
      [req.params.id, user.id], () => { db.close(); resolve(); });
  });
  res.json({ status: 'success', data: { deleted: req.params.id } });
});

/** Активные заявки на вывод в крипте. Пустой список — нормальный ответ. */
app.get('/api/v1/wallet/crypto/withdrawals', async (req, res) => {
  res.json({ status: 'success', data: [] });
});

/**
 * Допуск к выводу и дневные лимиты.
 *
 * Фронт читает cap и remaining, чтобы показать «Доступно сегодня». Без ответа
 * поля остаются пустыми и кнопка вывода не включается.
 */
app.get('/api/v1/wallet/eligibility', async (req, res) => {
  const limits = await adminSetting('wallet_config', {});
  const cap = Number(limits.dailyWithdrawCap ?? 27000);
  const user = (await currentUser(req, mockUser)) || guestUser();

  let spentToday = 0;
  if (!user.isGuest) {
    await ensureTxSchema();
    const rows = await queryAdminDb(
      `SELECT COALESCE(SUM(ABS(amount)), 0) AS s FROM transactions
        WHERE user_id = ? AND type = 'withdraw' AND datetime(created_at) >= datetime('now', '-1 day')`,
      [user.id]);
    spentToday = rows.length ? Number(rows[0].s) || 0 : 0;
  }
  const remaining = Math.max(0, cap - spentToday);

  res.json({
    status: 'success',
    data: {
      allowed: !user.isGuest,
      channels: {
        SKINS: { cap, remaining, used: spentToday },
        CRYPTO: { cap, remaining, used: spentToday }
      },
      cap, remaining, used: spentToday,
      minWithdraw: Number(limits.minWithdraw ?? 500)
    }
  });
});

/** Лимит расходов. Форма та же, отдельная ручка — так зовёт фронт. */
app.get('/api/v1/wallet/expense-limit', async (req, res) => {
  const limits = await adminSetting('wallet_config', {});
  const cap = Number(limits.dailyWithdrawCap ?? 27000);
  res.json({
    status: 'success',
    data: { cap, remaining: cap, used: 0, period: 'day', currency: 'RUB' }
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

/**
 * Заявка на пополнение.
 *
 * Раньше этот роут НАЧИСЛЯЛ деньги сразу, ничего не проверяя: провайдера нет,
 * оплаты не происходит, а баланс рос. Любой вошедший игрок мог выписать себе
 * до 500 000 ₽ одним запросом и повторять сколько угодно.
 *
 * Теперь создаётся заявка со статусом pending. Деньги начисляет только
 * deposits.confirm() — из админки либо из вебхука провайдера, когда он
 * появится. Других путей к балансу отсюда нет.
 */
app.post(['/api/v1/wallet/deposit/card', '/api/v1/wallet/deposit'], async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'Нужна авторизация' });
  }

  const amount = Math.round(Number(req.body?.amount) || 0);
  const limits = await adminSetting('wallet_config', {});
  const min = Number(limits.minDeposit ?? 100);
  const max = Number(limits.maxDeposit ?? 150000);
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    // Код читается бандлом дословно: по нему показывается сообщение про
    // предельную сумму. Любой другой уходит в общий «что-то пошло не так».
    return res.status(400).json({
      status: 'error', code: 'DEPOSIT_AMOUNT_OUT_OF_RANGE',
      message: `Сумма пополнения — от ${min} до ${max} ₽`
    });
  }

  const method = String(req.body?.method || req.body?.paymentMethod || 'card');
  const deposit = await deposits.create({
    user, method, amount,
    phone: req.body?.phone || null,
    promo: req.body?.promoCode || req.body?.promo || null
  });
  if (!deposit) {
    return res.status(500).json({ status: 'error', message: 'Не удалось создать заявку' });
  }

  console.log(`[Пополнение] Заявка ${deposit.uid}: ${user.username} на ${amount} ₽ (${method})`);

  // Шлюз настроен — заводим платёж и уводим игрока на его форму.
  // order_id это наш uid: по нему вебхук найдёт заявку обратно.
  if (rollypay.isConfigured()) {
    const pay = await rollypay.createPayment({
      orderId: deposit.uid,
      amount,
      method,
      customerId: user.id,
      successUrl: `${PUBLIC_URL}/wallet?deposit=${deposit.uid}&result=success`,
      failUrl: `${PUBLIC_URL}/wallet?deposit=${deposit.uid}&result=fail`,
      metadata: { userId: String(user.id), username: user.username }
    });

    if (!pay.ok) {
      // Заявку не бросаем: пусть останется в админке как след неудачи.
      await deposits.markFailed(deposit.uid, pay.message || 'Шлюз недоступен');
      return res.status(502).json({
        status: 'error', code: 'GATEWAY',
        message: 'Платёжный шлюз недоступен, попробуйте позже'
      });
    }

    await deposits.attachProvider(deposit.uid, 'rollypay', pay.paymentId);
    return res.json({
      status: 'success',
      data: {
        ...deposit, provider: 'rollypay', providerRef: pay.paymentId,
        // redirectUrl — единственное поле, которое бандл действительно читает:
        //   const o = s?.data?.redirectUrl
        //   if (!o) return error('deposit.card.errorNoRedirect')
        // Без него игрок видел «Не удалось получить ссылку для оплаты», хотя
        // заявка создавалась и ссылка приходила от шлюза. Остальные имена
        // оставлены дублями.
        redirectUrl: pay.payUrl,
        url: pay.payUrl, paymentUrl: pay.payUrl, payUrl: pay.payUrl,
        message: 'Перейдите к оплате'
      }
    });
  }

  // Шлюза нет — заявка ждёт подтверждения администратором. Ссылку всё равно
  // отдаём: без redirectUrl фронт покажет «Не удалось получить ссылку для
  // оплаты», хотя заявка на самом деле создана и висит в админке.
  const back = `${PUBLIC_URL}/wallet?deposit=${deposit.uid}&pending=1`;
  res.json({
    status: 'success',
    data: {
      ...deposit,
      redirectUrl: back,
      url: back, paymentUrl: back,
      message: 'Заявка создана и ждёт подтверждения оплаты'
    }
  });
});

/**
 * Вебхук RollyPay.
 *
 * Подпись считается от `timestamp + "." + сырое тело` ключом signing_secret.
 * Отвечать надо 2xx в течение 10 секунд, иначе шлюз повторит доставку — до
 * восьми раз с нарастающей паузой. Поэтому на любое уже обработанное событие
 * отвечаем 200: повтор не должен выглядеть отказом.
 *
 * Начисление идемпотентно само по себе (deposits.confirm переводит заявку из
 * pending одним UPDATE), так что восемь повторов одного платежа дадут деньги
 * ровно один раз.
 */
app.post(['/api/v1/wallet/deposit/rollypay/callback', '/api/v1/payments/callback'], async (req, res) => {
  const verdict = rollypay.verifyWebhook({
    rawBody: req.rawBody,
    signature: req.headers['x-signature'],
    timestamp: req.headers['x-timestamp']
  });
  if (!verdict.ok) {
    console.warn(`[RollyPay] вебхук отклонён: ${verdict.reason}`);
    return res.status(401).json({ status: 'error', message: 'Подпись не подтверждена' });
  }

  const body = req.body || {};
  const event = String(body.event_type || '');
  const orderId = String(body.order_id || '');
  console.log(`[RollyPay] ${event} по заявке ${orderId}, статус ${body.status}`);

  if (!orderId) return res.json({ status: 'success', ignored: 'нет order_id' });

  if (event === 'payment.paid' || body.status === 'paid') {
    const r = await deposits.confirm(orderId, {
      by: 'rollypay',
      providerRef: body.payment_id || null,
      // Сумму берём свою, из заявки: шлюз удерживает комиссию из платежа,
      // и в вебхуке может прийти уже за её вычетом. Игрок заплатил столько,
      // сколько заказывал, — столько и получает.
      amount: null
    });
    if (r.ok) console.log(`[RollyPay] заявка ${orderId} оплачена, начислено ${r.credited} ₽`);
    else console.log(`[RollyPay] заявка ${orderId}: ${r.message}`);
    // 200 в любом случае — повтор доставки нам не нужен.
    return res.json({ status: 'success' });
  }

  if (['payment.canceled', 'payment.expired'].includes(event)) {
    await deposits.reject(orderId, { by: 'rollypay', comment: `Шлюз: ${event}` });
    return res.json({ status: 'success' });
  }

  // Остальные события просто подтверждаем.
  res.json({ status: 'success' });
});

/** Опрос статуса заявки. Фронт зовёт это после создания. */
app.post(['/api/v1/wallet/deposit/card/status', '/api/v1/wallet/deposit/status'], async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'Нужна авторизация' });
  }
  const uid = String(req.body?.id || req.body?.depositId || req.body?.uid || '');
  const row = await deposits.forUser(uid, user.id);
  if (!row) {
    return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Заявка не найдена' });
  }
  const dto = deposits.toDto(row);
  res.json({
    status: 'success',
    data: { ...dto, paid: dto.status === 'paid', balance: (await getBalance(req, mockUser)) ?? 0 }
  });
});

/**
 * Таблица заявок на вывод. Изначально в ней были только сумма и статус,
 * поэтому в админке заявка выглядела строкой без монеты, сети и адреса —
 * обработать такую невозможно. Недостающие колонки добавляются на месте.
 */
let withdrawSchemaReady = false;
async function ensureWithdrawSchema() {
  if (withdrawSchemaReady) return;
  const cols = ['channel TEXT', 'method_id TEXT', 'asset TEXT', 'network TEXT',
                'address TEXT', 'wallet_label TEXT', 'fee REAL DEFAULT 0',
                'payout REAL DEFAULT 0', 'comment TEXT', 'settled_at TIMESTAMP',
                'settled_by TEXT'];
  for (const c of cols) {
    await new Promise((resolve) => {
      const db = getAdminDb(); if (!db) return resolve();
      // ALTER падает, если колонка уже есть — это нормально, ошибку глушим.
      db.run(`ALTER TABLE withdrawals ADD COLUMN ${c}`, () => { db.close(); resolve(); });
    });
  }
  withdrawSchemaReady = true;
}

/** Комиссия и сумма к получению по выбранному способу. */
async function withdrawQuote({ amount, methodId }) {
  const cfg = await walletConfig.build({});
  const method = cfg.withdraw.methods.find(m => m.id === methodId)
    || cfg.withdraw.methods.find(m => m.category === 'crypto');
  const feePercent = Number(method?.feePercent) || 0;
  const fee = Math.round(amount * feePercent) / 100;
  const payout = Math.max(0, Math.round((amount - fee) * 100) / 100);
  const rate = Number(cfg.rates?.[method?.asset] || 0);
  return {
    method, feePercent, fee, payout,
    // Сколько это в монете по текущему курсу — фронт показывает под суммой.
    payoutCrypto: rate > 0 ? +(payout / rate).toFixed(8) : null,
    asset: method?.asset || null,
    network: method?.network || null,
    rate
  };
}

/**
 * Предпросчёт вывода. Фронт зовёт его перед подтверждением, чтобы показать
 * комиссию и сумму к получению. Без него кнопка вывода не активируется.
 */
app.post('/api/v1/wallet/withdraw/crypto/preview', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'Нужна авторизация' });
  }
  const amount = Math.round(Number(req.body?.amount) || 0);
  if (amount <= 0) {
    return res.status(400).json({ status: 'error', message: 'Некорректная сумма вывода' });
  }
  const q = await withdrawQuote({ amount, methodId: req.body?.withdraw_method_id });
  res.json({
    status: 'success',
    data: {
      amount, fee: q.fee, feePercent: q.feePercent,
      receive: q.payout, payout: q.payout,
      receiveCrypto: q.payoutCrypto, payoutCrypto: q.payoutCrypto,
      asset: q.asset, network: q.network, rate: q.rate, currency: 'RUB'
    }
  });
});

app.post('/api/v1/wallet/withdraw', async (req, res) => {
  const user = (await currentUser(req, mockUser)) || guestUser();
  if (user.isGuest) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'Нужна авторизация' });
  }

  const body = req.body || {};
  const channel = String(body.channel || 'CRYPTO').toUpperCase();
  const amount = Math.round(Number(body.amount) || 0);
  const limits = await adminSetting('wallet_config', {});
  const min = Number(limits.minWithdraw ?? 500);

  if (amount < min) {
    return res.status(400).json({
      status: 'error', code: 'AMOUNT_TOO_SMALL',
      message: `Минимальная сумма вывода — ${min} ₽`
    });
  }

  const balance = await balanceForSpending(req, res, mockUser);
  if (balance === null) return;
  if (balance < amount) {
    return res.status(400).json({ status: 'error', code: 'INSUFFICIENT_BALANCE',
      message: `Недостаточно средств: на балансе ${balance} ₽` });
  }

  // Кошелёк игрока: из него берутся монета, сеть и адрес. Без него заявку
  // в крипте обработать нельзя — некуда отправлять.
  let wallet = null;
  if (channel === 'CRYPTO') {
    await ensureWalletsSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM user_crypto_wallets WHERE id = ? AND user_id = ?`,
      [body.crypto_wallet_id, user.id]);
    wallet = rows[0] || null;
    if (!wallet) {
      return res.status(400).json({
        status: 'error', code: 'WALLET_NOT_FOUND',
        message: 'Кошелёк не найден. Добавьте его заново.'
      });
    }
  }

  const q = await withdrawQuote({ amount, methodId: body.withdraw_method_id });

  await ensureWithdrawSchema();
  const newBalance = await adjustBalance(req, mockUser, -amount);
  await recordTransaction(req, 'withdraw', -amount,
    channel === 'CRYPTO' ? `Вывод ${wallet?.asset || ''} ${wallet?.network || ''}`.trim() : 'Вывод скинов');

  let requestId = null;
  await new Promise((resolve) => {
    const db = getAdminDb(); if (!db) return resolve();
    db.run(
      `INSERT INTO withdrawals (user_id, amount, currency, status, channel, method_id,
                                asset, network, address, wallet_label, fee, payout)
       VALUES (?, ?, 'RUB', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, amount, channel, body.withdraw_method_id || null,
       wallet?.asset || null, wallet?.network || null, wallet?.address || null,
       wallet?.label || null, q.fee, q.payout],
      function () { requestId = this.lastID; db.close(); resolve(); });
  });

  console.log(`[Вывод] Заявка №${requestId}: ${user.username}, ${amount} ₽ (${channel}` +
    (wallet ? `, ${wallet.asset} ${wallet.network}` : '') + ')');

  res.json({
    status: 'success',
    data: {
      request_id: requestId, id: requestId,
      amount, fee: q.fee, payout: q.payout,
      asset: wallet?.asset || null, network: wallet?.network || null,
      address: wallet?.address || null,
      status: 'pending', channel,
      newBalance, balance: newBalance,
      needs_confirmation: false
    },
    message: 'Заявка на вывод создана и ждёт проверки'
  });
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

/*
 * Статика бандла.
 *
 * Имена чанков содержат хеш содержимого, поэтому их можно было бы кэшировать
 * надолго. Но здесь этот договор нарушен намеренно: при ребрендинге
 * содержимое картинок и части чанков заменено ПОД ПРЕЖНИМИ ИМЕНАМИ — иначе
 * пришлось бы править ссылки внутри минифицированной сборки, которых сотни.
 *
 * Из-за этого посетитель, у которого файл уже в кэше, продолжал видеть старую
 * картинку: имя не изменилось, значит браузер считает, что и содержимое то же.
 * Так на сайте ещё долго оставался прежний логотип и силуэты, хотя на сервере
 * лежали новые.
 *
 * Поэтому просим перепроверять. must-revalidate не значит «качать каждый раз»:
 * браузер шлёт If-None-Match, и на неизменившийся файл получает 304 без тела.
 * Трафика это почти не добавляет, а картинку показывает актуальную.
 *
 * Когда сборка фронта начнёт менять имена файлов честно, это правило можно
 * будет снять.
 */
const ASSET_REVALIDATE = /\.(svg|png|webp|jpg|jpeg|ico|gif|avif)$/i;

app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (ASSET_REVALIDATE.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
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
/**
 * Карта сайта.
 *
 * Собирается из базы, а не лежит файлом: кейсы заводят и архивируют в
 * админке, и статический sitemap протух бы на второй неделе. Архивные и
 * неактивные кейсы в карту не попадают — отправлять краулер на страницу,
 * которую он не сможет открыть, значит тратить бюджет обхода впустую.
 */
app.get('/sitemap.xml', async (req, res) => {
  const base = PUBLIC_URL.replace(/\/+$/, '');
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const staticPages = [
    { loc: '/', priority: '1.0', freq: 'daily' },
    { loc: '/crate-pvp', priority: '0.8', freq: 'hourly' },
    { loc: '/upgrader', priority: '0.8', freq: 'daily' },
    { loc: '/giveaway', priority: '0.7', freq: 'daily' },
    { loc: '/terms-and-conditions', priority: '0.3', freq: 'yearly' },
    { loc: '/privacy-policy', priority: '0.3', freq: 'yearly' },
    { loc: '/refund-policy', priority: '0.3', freq: 'yearly' }
  ];

  let cases = [];
  try {
    cases = await queryAdminDb(
      // created_at, а не updated_at: такой колонки в cases нет, и запрос
      // молча падал в catch — карта выходила без единого кейса.
      `SELECT slug, created_at FROM cases
        WHERE slug IS NOT NULL AND slug <> '' AND (archived IS NULL OR archived = 0)
        ORDER BY sortOrder ASC, id ASC LIMIT 2000`);
  } catch { cases = []; }

  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ...staticPages.map(p => `  <url>
    <loc>${esc(base + p.loc)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.freq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`),
    ...cases.map(c => `  <url>
    <loc>${esc(base + '/cases/' + c.slug)}</loc>
    <lastmod>${String(c.created_at || today).slice(0, 10)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`)
  ];

  // Собираем через join, а не одним шаблоном: перевод строки внутри шаблонной
  // строки здесь уже ломал файл при генерации.
  const NL = String.fromCharCode(10);
  res.type('application/xml').send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls.join(NL),
    '</urlset>',
    ''
  ].join(NL));
});

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
  // Обновление цен из lis-skins. Весь каталог приходит одним запросом,
  // поэтому это можно делать часто — в отличие от обхода Steam Market, где
  // круг по 543 запроса занимает около получаса.
  //
  // Редкость и картинки здесь не трогаются: в выгрузке их нет, и берутся они
  // только из обхода Steam Market. Поэтому обход остаётся включённым — он ищет
  // новые предметы и задаёт им редкость, просто больше не отвечает за цены.
  if (PRICE_REFRESH_MS > 0) {
    const refresh = async () => {
      try {
        const db = openCatalogDb();
        if (!db) return;
        // Курс больше не нужен: rust.tm отдаёт цены сразу в рублях.
        const r = await rustTm.refreshPrices({
          db,
          run: (d, sql, prm) => new Promise((res) => d.run(sql, prm, function (e) { res(e ? null : this); })),
          all: (d, sql, prm) => new Promise((res) => d.all(sql, prm, (e, rows) => res(e ? [] : rows || [])))
        });
        db.close();
        if (r.ok) {
          const capped = r.capped ? `, срезано по потолку ${r.capped}` : '';
          console.log(`[Цены] rust.tm: обновлено ${r.updated} из ${r.fromApi}, `
                    + `сдвиг ${r.shiftPercent}%${capped}`);
        } else {
          console.warn(`[Цены] Не обновились: ${r.message}`);
        }
      } catch (e) { console.warn(`[Цены] ${e.message}`); }
    };
    setTimeout(refresh, 15000).unref?.();
    setInterval(refresh, PRICE_REFRESH_MS).unref?.();
  }

  // Курсы кошелька. Без этого USDT стоял бы тем значением, что записали при
  // создании таблицы: на боевом сервере оно не менялось с 23 августа.
  const refreshRates = async () => {
    try {
      const r = await rates.refresh({ force: true });
      if (r?.written?.length) {
        console.log(`[Курсы] Обновлено: ${r.written.join(', ')}${r.skippedManual.length ? ` (вручную: ${r.skippedManual.join(', ')})` : ''}`);
      }
      if (r?.failed?.length) console.warn(`[Курсы] Не записались: ${r.failed.join('; ')}`);
    } catch (e) { console.warn(`[Курсы] ${e.message}`); }
  };
  setTimeout(refreshRates, 5000).unref?.();
  setInterval(refreshRates, rates.RATES_TTL_MS).unref?.();

  /*
   * Здоровье базы до всего остального.
   *
   * Повреждение индекса проявляется коварно: COUNT(*) по таблице работает, а
   * выборка с ORDER BY по индексу падает с SQLITE_CORRUPT. Сайт при этом
   * выглядит живым, просто каталог «пуст». Именно так и случилось на рабочем
   * сервере: 5445 предметов на месте, а лента пустая.
   *
   * REINDEX перестраивает индексы из таблицы, данные не трогает.
   */
  // Итог проверки целостности: по нему ниже решается, можно ли вообще
  // что-то писать в базу.
  let dbHealthy = true;

  try {
    const hdb = openCatalogDb();
    if (hdb) {
      hdb.configure('busyTimeout', 15000);
      const q = (sql) => new Promise((res) => hdb.get(sql, (e, r) => res({ e, r })));
      const exec = (sql) => new Promise((res) => hdb.run(sql, (e) => res(e)));

      const first = await q('PRAGMA quick_check');
      const verdict = first.r ? Object.values(first.r)[0] : (first.e && first.e.message);

      if (verdict !== 'ok') {
        console.warn('');
        console.warn(` [!] База повреждена: ${verdict}`);
        console.warn(' [~] Перестраиваю индексы (REINDEX)…');

        const err = await exec('REINDEX');
        const again = await q('PRAGMA quick_check');
        const after = again.r ? Object.values(again.r)[0] : (again.e && again.e.message);

        if (!err && after === 'ok') {
          console.log(' [~] Индексы перестроены, база в порядке. Данные не тронуты.');
        } else {
          dbHealthy = false;
          /*
           * REINDEX не сработал — и это обычный исход, а не редкость.
           * Проверено на воспроизведённом повреждении: обнаружив битую
           * страницу, SQLite отказывается выполнять и REINDEX, и DROP INDEX,
           * и VACUUM. Починить базу «на месте» нельзя.
           *
           * Работает пересборка: прочитать всё, что читается, и записать в
           * новый файл. Этим занимается deploy/repair-db.js — он делает копию
           * до всяких изменений, собирает новый файл рядом, сверяет число
           * строк по каждой таблице и только потом подменяет рабочий.
           *
           * Автоматически здесь не запускаем: подмена базы под работающим
           * сайтом — не то действие, которое стоит делать без ведома
           * человека, даже с копией.
           */
          console.error(' [!] Починить на месте не вышло — так с SQLite и бывает.');
          const firstLine = String(after).split(String.fromCharCode(10))[0];
          console.error(`     Проверка после REINDEX: ${firstLine}`);
          console.error('     Данные, скорее всего, целы: повреждён индекс, а не таблица.');
          console.error('     Восстановить (сделает копию и сверит все строки):');
          console.error('       pm2 stop main-site admin-panel');
          console.error('       node deploy/repair-db.js            # посмотреть');
          console.error('       node deploy/repair-db.js --apply    # восстановить');
          console.error('       pm2 start main-site admin-panel');
        }
        console.warn('');
      }
      hdb.close();
    }
  } catch (e) {
    console.warn(` [!] Проверка базы не удалась: ${e.message}`);
  }

  /*
   * Расхождение схемы: на части установок в series нет колонок isSecret и
   * isLimited. Запрос секретных серий падал с "no such column" и молча отдавал
   * пустоту, из-за чего секретные серии просто не показывались.
   *
   * ALTER идемпотентен: повторный запуск получит "duplicate column" и молча
   * его проглотит, как ensureCatalogSchema.
   */
  try {
    const sdb = getAdminDb();
    if (sdb) {
      for (const col of ['isSecret INTEGER DEFAULT 0', 'isLimited INTEGER DEFAULT 0']) {
        await new Promise((res) => sdb.run(`ALTER TABLE series ADD COLUMN ${col}`, () => res()));
      }
      sdb.close();
    }
  } catch {}

  // Состояние каталога прямо в лог. Пустая таблица предметов проявляется
  // на сайте странно: лента показывает один и тот же предмет из запасного
  // списка, зашитого в код, и выглядит это как поломка вёрстки, а не как
  // отсутствие данных. Лучше сказать прямо.
  try {
    const rows = await queryAdminDb(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN delisted = 1 THEN 1 ELSE 0 END) AS hidden FROM items`);

    /*
     * Сбой чтения — это НЕ пустой каталог.
     *
     * queryAdminDb при ошибке возвращает пустой массив, и rows[0]?.total даёт
     * undefined, а значит ноль. Раньше сервер принимал это за пустую таблицу
     * и запускал наполнение прямо в повреждённую базу: качал выгрузку, ходил
     * в Steam и пытался записать 4900 строк, каждая из которых падала. При
     * каждом перезапуске заново.
     */
    if (rows.failed) {
      console.error('');
      console.error(' [!] Каталог прочитать не удалось — база не ответила.');
      console.error('     Это НЕ пустой каталог: наполнение не запускается,');
      console.error('     чтобы не писать в неисправную базу.');
      console.error('     Проверить и восстановить: node deploy/repair-db.js');
      console.error('');
      return;
    }

    const total = Number(rows[0]?.total) || 0;
    const hidden = Number(rows[0]?.hidden) || 0;
    const usable = total - hidden;

    if (usable > 0) {
      console.log(` Каталог предметов: ${usable} доступно` + (hidden ? `, скрыто ${hidden}` : ''));
    } else {
      console.warn('');
      console.warn(' [!] КАТАЛОГ ПУСТ — доступных предметов нет.');
      console.warn(`     Всего строк в items: ${total}, из них скрыто: ${hidden}`);
      if (total > 0 && hidden === total) {
        console.warn('     Все предметы помечены снятыми с продажи. Снять пометку:');
        console.warn('     UPDATE items SET delisted = 0 WHERE price_usd_cents IS NOT NULL;');
      } else {
        console.warn('     Предметов нет вовсе.');
      }
      console.warn('     Пока каталог пуст, лента и кейсы будут пустыми:');
      console.warn('     выдуманных предметов сервер больше не подставляет.');
      console.warn('');

      /*
       * Наполняем сами.
       *
       * Раньше пустой каталог оставался пустым до тех пор, пока кто-нибудь не
       * заметит и не запустит наполнение руками, а сайт всё это время
       * показывал подставные предметы и выглядел рабочим. Теперь подставных
       * нет, и оставлять сайт пустым в ожидании ручного действия незачем:
       * rust.tm отдаёт каталог одним открытым запросом, без ключа.
       *
       * Условия намеренно узкие. Наполнение запускается ТОЛЬКО когда доступных
       * предметов ноль: непустой каталог не трогается никогда, чтобы автозапуск
       * не переписал цены под живым сайтом. Отключается CATALOG_AUTOSEED=0.
       */
      if (!dbHealthy) {
        console.warn('     Наполнение пропущено: база не прошла проверку целостности.');
        console.warn('     Сначала восстановите её: node deploy/repair-db.js --apply');
      } else if (String(process.env.CATALOG_AUTOSEED || '1') !== '0') {
        console.warn(' [~] Наполняю каталог из rust.tm…');
        try {
          const seeder = require('./services/catalogSeed');
          const sdb = openCatalogDb();
          if (!sdb) throw new Error('база каталога недоступна');
          sdb.configure('busyTimeout', 15000);
          const r = await seeder.seed({ db: sdb, apiKey: process.env.STEAM_API_KEY });
          sdb.close();
          if (r.ok) {
            console.log(` [~] Каталог наполнен: ${r.created} новых, ${r.updated} обновлено`
                      + (r.noImage ? `, без картинок ${r.noImage}` : ''));
          } else {
            console.warn(` [!] Наполнить не вышло: ${r.message}`);
            console.warn('     Запустить вручную: node deploy/seed-catalog.js --apply');
          }
        } catch (e) {
          console.warn(` [!] Наполнить не вышло: ${e.message}`);
          console.warn('     Запустить вручную: node deploy/seed-catalog.js --apply');
        }
      } else {
        console.warn('     Автонаполнение отключено (CATALOG_AUTOSEED=0).');
        console.warn('     Наполнить вручную: node deploy/seed-catalog.js --apply');
      }
    }
  } catch (e) {
    console.warn(` [!] Не удалось прочитать каталог: ${e.message}`);
  }

  console.log(` Каталог Steam: ${catalogEnabled
    ? `обход включён (${CATALOG_PAGE_SIZE} поз./запрос, интервал ${CATALOG_INTERVAL_MS} мс)`
    : 'выключен (STEAM_CATALOG_SYNC=0)'}`);
  console.log(` Цены rust.tm: ${PRICE_REFRESH_MS > 0
    ? `каждые ${Math.round(PRICE_REFRESH_MS / 60000)} мин, опора «${rustTm.PRICE_FIELD}»`
    : 'только вручную (PRICE_REFRESH_MS=0)'}`);
  if (ALLOW_MOCK_AUTH) {
    console.log(` [!] ALLOW_MOCK_AUTH включён — без токена отдаётся моковый профиль.`);
    console.log(`     В проде запускать с NODE_ENV=production.`);
  }
  console.log(`================================================`);
});
