'use strict';

/**
 * Полный каталог предметов Rust со Steam Community Market.
 *
 * ЧТО ПРОВЕРЕНО ЖИВЫМИ ЗАПРОСАМИ (2026-08-23), а не взято из документации:
 *
 *  1. Размер страницы жёстко ограничен 10.
 *     count=100 / 50 / 20 возвращают ровно 10 и pagesize:10 — и с norender=1,
 *     и без него. Значит полный каталог (total_count = 5430) — это 543 запроса.
 *
 *  2. Валюта всегда USD. currency=5, country=RU, l=russian, Accept-Language: ru
 *     и cookie steamCountry=RU игнорируются для анонимных запросов: цена
 *     приходит как "$7.22" (sell_price = 722, то есть центы).
 *     Поэтому цены конвертируются здесь; курс задаётся в USD_RUB_RATE.
 *
 *  3. Редкость берётся из asset_description.name_color. Поля tags у предметов
 *     Rust нет. На 160 предметах встретились ровно 4 цвета:
 *        #f15840  35.0%   $0.83–$29.28
 *        #35a3f1  32.5%   $0.66–$9.35
 *        #a7ec2e  31.3%   $0.74–$23.51
 *        #dddddd   1.3%   $0.15–$0.20
 *     Диапазоны цен сильно перекрываются, поэтому определять редкость по цене
 *     (как делает старый getRarity в steamSync.js) — неверно.
 *
 * ПОЧЕМУ НЕ «РАЗ В 30 СЕКУНД»: 543 запроса за 30 с — это 1086 запросов в минуту.
 * Безопасный анонимный темп для market-эндпоинтов ~20 запросов в минуту; выше —
 * HTTP 429 и временная блокировка IP. Поэтому здесь скользящее обновление:
 * воркер непрерывно идёт по каталогу, а сайт читает готовые данные из SQLite
 * (свежесть отдачи — секунды, см. кэш в server.js). Полный круг ≈ 27 минут при
 * интервале 3 с. Ускорять можно только уменьшив REQUEST_INTERVAL_MS, и это
 * прямо повышает риск бана.
 */

const https = require('https');
const sqlite3 = require('sqlite3').verbose();

const { ADMIN_DB_PATH } = require('./steamSync');

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

const RUST_APP_ID = 252490;
const MARKET_SEARCH = 'https://steamcommunity.com/market/search/render/';
const IMAGE_BASE = 'https://community.cloudflare.steamstatic.com/economy/image/';

/** Steam отдаёт максимум 10 позиций за запрос — проверено, не менять. */
const PAGE_SIZE = 10;

/** Пауза между запросами к Steam. Ниже 2000 мс — реальный риск 429. */
const REQUEST_INTERVAL_MS = Number(process.env.STEAM_REQUEST_INTERVAL_MS || 3000);

/** Пауза между полными кругами обхода каталога. */
const SWEEP_PAUSE_MS = Number(process.env.STEAM_SWEEP_PAUSE_MS || 60 * 1000);

/** Курс USD→RUB. Обновляется автоматически, env задаёт стартовое значение. */
const FALLBACK_USD_RUB = Number(process.env.USD_RUB_RATE || 83);

/** Наценка магазина к рыночной цене, 1.0 = без наценки. */
const PRICE_MULTIPLIER = Number(process.env.PRICE_MULTIPLIER || 1);

/** Предметы дороже этого порога (₽) поднимаются в тир GOLD. 0 — отключить. */
const GOLD_MIN_PRICE_RUB = Number(process.env.GOLD_MIN_PRICE_RUB || 5000);

const MAX_BACKOFF_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Редкость: Steam name_color → тир сайта
// ---------------------------------------------------------------------------

/**
 * Порядок редкости в Rust: Common < Uncommon < Rare < Very Rare.
 * Палитра сайта (rarity-DBZTLmta.js): REGULAR < UNUSUAL < RARE < VIOLET < GOLD.
 *
 * Соответствие выстроено ПО РАНГУ, а не по похожести цвета: редкость — это
 * ранжирование, а свои цвета сайт задаёт сам. Оригинальный цвет Steam при этом
 * сохраняется в колонке rarity_color, если он где-то понадобится.
 */
const COLOR_TO_RARITY = {
  dddddd: { rarity: 'REGULAR', steamTier: 'Common', rank: 0 },
  a7ec2e: { rarity: 'UNUSUAL', steamTier: 'Uncommon', rank: 1 },
  '35a3f1': { rarity: 'RARE', steamTier: 'Rare', rank: 2 },
  f15840: { rarity: 'VIOLET', steamTier: 'Very Rare', rank: 3 }
};

/** Цвета тиров сайта — из public/assets/js/rarity-DBZTLmta.js. */
const RARITY_HEX = {
  REGULAR: '756767',
  UNUSUAL: '4076ff',
  RARE: '65dc04',
  VIOLET: 'a33ee2',
  GOLD: 'ffc43b'
};

function classifyRarity(nameColor, priceRub) {
  const key = String(nameColor || '').replace('#', '').toLowerCase();
  const hit = COLOR_TO_RARITY[key];
  let rarity = hit ? hit.rarity : 'REGULAR';

  // Верхний тир сайта иначе остался бы пустым: Steam не выделяет «золото».
  if (GOLD_MIN_PRICE_RUB > 0 && priceRub >= GOLD_MIN_PRICE_RUB) rarity = 'GOLD';

  return {
    rarity,
    steamTier: hit ? hit.steamTier : 'Unknown',
    steamColor: key || null,
    hex: RARITY_HEX[rarity]
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ status: res.statusCode, json: null });
        try { resolve({ status: 200, json: JSON.parse(data) }); }
        catch { resolve({ status: 200, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// База
// ---------------------------------------------------------------------------

function openDb() {
  try { return new sqlite3.Database(ADMIN_DB_PATH); } catch { return null; }
}
const run = (db, sql, p = []) => new Promise((res) => db.run(sql, p, function (e) { res(e ? null : this); }));
const get = (db, sql, p = []) => new Promise((res) => db.get(sql, p, (e, r) => res(e ? null : r)));
const all = (db, sql, p = []) => new Promise((res) => db.all(sql, p, (e, r) => res(e ? [] : r || [])));

let schemaReady = false;

/**
 * Таблицу items создаёт админка; здесь только доливаем недостающие колонки.
 * Все ALTER идемпотентны — повторный запуск получит «duplicate column» и молча
 * его проглотит, ровно как ensureAuthSchema в services/auth.js.
 */
async function ensureCatalogSchema(db) {
  if (schemaReady) return;
  for (const col of [
    'price_usd_cents INTEGER',
    'rarity_color TEXT',
    'steam_tier TEXT',
    'sell_listings INTEGER DEFAULT 0',
    'classid TEXT',
    'icon_hash TEXT',
    'delisted INTEGER DEFAULT 0',
    'last_seen_at TIMESTAMP',
    'last_sweep_id INTEGER'
  ]) {
    await run(db, `ALTER TABLE items ADD COLUMN ${col}`);
  }
  await run(db, `CREATE INDEX IF NOT EXISTS idx_items_rarity ON items(rarity)`);
  await run(db, `CREATE INDEX IF NOT EXISTS idx_items_price ON items(price)`);
  await run(db, `CREATE INDEX IF NOT EXISTS idx_items_delisted ON items(delisted)`);
  await run(db, `CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await normalizeLegacyRarities(db);
  await repairFalseDelisted(db);
  schemaReady = true;
}

/**
 * Разовое исправление последствий бага со сравнением дат.
 *
 * Пометка delisted раньше сравнивала last_seen_at (формат SQLite
 * "2026-08-23 13:55:32") со строкой из toISOString()
 * ("2026-08-23T14:56:37.516Z"). Пробел на 10-й позиции меньше 'T', поэтому
 * условие срабатывало для всех строк и весь каталог уходил в delisted=1.
 *
 * Возвращаем в продажу всё, что реально пришло из Steam (price_usd_cents
 * заполнен). Настоящие снятия проставит первый же круг с новой логикой по
 * last_sweep_id. Выполняется один раз — дальше флаг в sync_state.
 */
async function repairFalseDelisted(db) {
  if (await stateGet(db, 'repair_false_delisted_done')) return;
  const r = await run(db, `UPDATE items SET delisted = 0
                           WHERE delisted = 1 AND price_usd_cents IS NOT NULL`);
  if (r && r.changes) console.log(`[Catalog] Восстановлено ошибочно скрытых предметов: ${r.changes}`);
  await stateSet(db, 'repair_false_delisted_done', new Date().toISOString());
}

/**
 * Приводит старые записи к палитре сайта.
 *
 * До этого сервиса редкость проставлял getRarity() из steamSync.js — по ЦЕНЕ и
 * в терминах CS:GO (COVERT / CLASSIFIED / RESTRICTED / MIL_SPEC / INDUSTRIAL /
 * CONSUMER). Фронт таких имён не знает (rarity-DBZTLmta.js понимает только
 * REGULAR / UNUSUAL / RARE / VIOLET / GOLD), поэтому такие предметы рисовались
 * серыми. Сопоставление — то же, что в mapRarity() в server.js.
 *
 * Строки, которые встретятся при обходе, всё равно будут перезаписаны реальными
 * данными из Steam; эта миграция нужна, чтобы каталог не выглядел сломанным до
 * завершения первого круга и чтобы предметы, уже вложенные в кейсы, получили
 * корректный тир.
 */
const LEGACY_RARITY_MAP = {
  COVERT: 'GOLD', MYTHIC: 'GOLD', GOLD: 'GOLD',
  CLASSIFIED: 'VIOLET', LEGENDARY: 'VIOLET', VIOLET: 'VIOLET',
  RESTRICTED: 'RARE', RARE: 'RARE',
  MIL_SPEC: 'UNUSUAL', 'MIL-SPEC': 'UNUSUAL', UNUSUAL: 'UNUSUAL',
  INDUSTRIAL: 'REGULAR', CONSUMER: 'REGULAR', COMMON: 'REGULAR', REGULAR: 'REGULAR'
};

async function normalizeLegacyRarities(db) {
  const rows = await all(db, `SELECT DISTINCT rarity FROM items WHERE rarity IS NOT NULL`);
  let changed = 0;
  for (const { rarity } of rows) {
    const key = String(rarity).toUpperCase().trim();
    const target = LEGACY_RARITY_MAP[key] || 'REGULAR';
    if (key === target && RARITY_HEX[target]) {
      // Имя уже верное — на всякий случай выравниваем цвет.
      await run(db, `UPDATE items SET color = ? WHERE rarity = ? AND (color IS NULL OR color <> ?)`,
        [RARITY_HEX[target], rarity, RARITY_HEX[target]]);
      continue;
    }
    const r = await run(db, `UPDATE items SET rarity = ?, color = ? WHERE rarity = ?`,
      [target, RARITY_HEX[target], rarity]);
    if (r && r.changes) { changed += r.changes; console.log(`[Catalog] Редкость: ${key} -> ${target} (${r.changes} шт.)`); }
  }
  if (changed) console.log(`[Catalog] Нормализовано записей: ${changed}`);
  return changed;
}

async function stateGet(db, key, fallback = null) {
  const row = await get(db, `SELECT value FROM sync_state WHERE key = ?`, [key]);
  return row ? row.value : fallback;
}
async function stateSet(db, key, value) {
  await run(db, `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, String(value)]);
}

// ---------------------------------------------------------------------------
// Курс валют
// ---------------------------------------------------------------------------

let usdRub = FALLBACK_USD_RUB;
let usdRubAt = 0;

async function refreshFxRate() {
  // Раз в 6 часов достаточно: на цену в ₽ курс влияет медленно.
  if (Date.now() - usdRubAt < 6 * 60 * 60 * 1000) return usdRub;
  const r = await fetchJson('https://api.exchangerate-api.com/v4/latest/USD', 8000);
  const rate = r.json && r.json.rates && Number(r.json.rates.RUB);
  if (rate && rate > 10 && rate < 1000) {
    usdRub = rate;
    usdRubAt = Date.now();
    console.log(`[Catalog] Курс USD→RUB обновлён: ${rate}`);
  } else if (!usdRubAt) {
    console.log(`[Catalog] Курс получить не удалось, используется USD_RUB_RATE=${usdRub}`);
    usdRubAt = Date.now();
  }
  return usdRub;
}

function usdCentsToRub(cents) {
  return Math.max(1, Math.round((cents / 100) * usdRub * PRICE_MULTIPLIER));
}

// ---------------------------------------------------------------------------
// Разбор одной страницы
// ---------------------------------------------------------------------------

function parseItem(raw) {
  const ad = raw.asset_description || {};
  const hash = raw.hash_name || ad.market_hash_name || raw.name;
  const iconHash = ad.icon_url || '';
  if (!hash || !iconHash) return null;

  const usdCents = Number(raw.sell_price) || 0;
  const priceRub = usdCentsToRub(usdCents);
  const cls = classifyRarity(ad.name_color, priceRub);

  return {
    marketHashName: hash,
    name: raw.name || hash,
    priceRub,
    usdCents,
    image: IMAGE_BASE + iconHash,
    iconHash,
    rarity: cls.rarity,
    steamTier: cls.steamTier,
    rarityColor: cls.steamColor,
    hex: cls.hex,
    sellListings: Number(raw.sell_listings) || 0,
    classid: ad.classid || null
  };
}

async function upsertBatch(db, items, sweepId) {
  if (!items.length) return 0;
  await run(db, 'BEGIN IMMEDIATE');
  let n = 0;
  for (const it of items) {
    const r = await run(db, `
      INSERT INTO items (market_hash_name, name, price, rarity, color, image,
                         upgraderEnabled, price_usd_cents, rarity_color, steam_tier,
                         sell_listings, classid, icon_hash, delisted, last_sweep_id,
                         last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(market_hash_name) DO UPDATE SET
        name            = excluded.name,
        price           = excluded.price,
        rarity          = excluded.rarity,
        color           = excluded.color,
        image           = excluded.image,
        price_usd_cents = excluded.price_usd_cents,
        rarity_color    = excluded.rarity_color,
        steam_tier      = excluded.steam_tier,
        sell_listings   = excluded.sell_listings,
        classid         = excluded.classid,
        icon_hash       = excluded.icon_hash,
        delisted        = 0,
        last_sweep_id   = excluded.last_sweep_id,
        last_seen_at    = CURRENT_TIMESTAMP,
        updated_at      = CURRENT_TIMESTAMP
    `, [it.marketHashName, it.name, it.priceRub, it.rarity, it.hex, it.image,
        it.usdCents, it.rarityColor, it.steamTier, it.sellListings, it.classid,
        it.iconHash, sweepId]);
    if (r) n++;
  }
  await run(db, 'COMMIT');
  return n;
}

// ---------------------------------------------------------------------------
// Воркер
// ---------------------------------------------------------------------------

const status = {
  running: false,
  phase: 'idle',
  offset: 0,
  totalCount: 0,
  itemsSeen: 0,
  itemsUpserted: 0,
  pagesOk: 0,
  pagesFailed: 0,
  rateLimitHits: 0,
  sweepStartedAt: null,
  lastSweepFinishedAt: null,
  lastSweepDurationMs: null,
  lastError: null,
  usdRub: usdRub,
  etaMs: null
};

let stopRequested = false;

function getStatus() {
  return { ...status, usdRub, requestIntervalMs: REQUEST_INTERVAL_MS, pageSize: PAGE_SIZE };
}

function pageUrl(start) {
  // sort_column=name даёт СТАБИЛЬНЫЙ порядок на всём обходе. При сортировке по
  // популярности (default) позиции переезжают между страницами прямо во время
  // обхода, и часть предметов теряется, а часть дублируется.
  return `${MARKET_SEARCH}?query=&start=${start}&count=${PAGE_SIZE}` +
         `&search_descriptions=0&sort_column=name&sort_dir=asc` +
         `&appid=${RUST_APP_ID}&norender=1`;
}

/** Один полный круг по каталогу. Возобновляется с сохранённого offset. */
async function runSweep(db) {
  await ensureCatalogSchema(db);
  await refreshFxRate();

  const resumeAt = Number(await stateGet(db, 'catalog_offset', '0')) || 0;

  // Номер круга вместо отметок времени. Сравнивать last_seen_at со строкой из
  // JS нельзя: SQLite пишет CURRENT_TIMESTAMP как "2026-08-23 13:55:32", а
  // toISOString() даёт "2026-08-23T14:56:37.516Z". На 10-й позиции пробел (0x20)
  // против 'T' (0x54), поэтому строковое сравнение ВСЕГДА истинно и снятыми с
  // продажи помечался весь каталог. Счётчик от формата времени не зависит.
  let sweepId = Number(await stateGet(db, 'catalog_sweep_id', '0')) || 0;
  const fullSweep = resumeAt === 0;         // круг с нуля, а не продолжение
  if (fullSweep) {
    sweepId += 1;
    await stateSet(db, 'catalog_sweep_id', sweepId);
  }
  status.sweepId = sweepId;
  status.offset = resumeAt;
  status.phase = 'sweeping';
  status.sweepStartedAt = new Date().toISOString();
  status.itemsSeen = 0;
  status.itemsUpserted = 0;
  status.pagesOk = 0;
  status.pagesFailed = 0;

  const sweepStartedMs = Date.now();
  let backoff = REQUEST_INTERVAL_MS;
  let offset = resumeAt;
  let total = status.totalCount || 5430;

  while (!stopRequested) {
    const res = await fetchJson(pageUrl(offset));

    if (res.status === 429 || res.status === 503) {
      status.rateLimitHits++;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      status.phase = `throttled (${Math.round(backoff / 1000)}s)`;
      status.lastError = `HTTP ${res.status} на offset ${offset}`;
      console.warn(`[Catalog] ${res.status} на offset ${offset}: пауза ${Math.round(backoff / 1000)} с`);
      await sleep(backoff);
      continue;                       // тот же offset, ничего не пропускаем
    }

    if (res.status !== 200 || !res.json || res.json.success !== true) {
      status.pagesFailed++;
      status.lastError = `HTTP ${res.status} на offset ${offset}`;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      if (status.pagesFailed > 40) {   // Steam недоступен — прекращаем круг
        status.phase = 'aborted';
        break;
      }
      continue;
    }

    backoff = REQUEST_INTERVAL_MS;
    status.phase = 'sweeping';
    status.pagesOk++;

    if (res.json.total_count) {
      total = res.json.total_count;
      status.totalCount = total;
    }

    const rows = res.json.results || [];
    if (!rows.length) break;           // конец каталога

    const parsed = rows.map(parseItem).filter(Boolean);
    status.itemsSeen += rows.length;
    status.itemsUpserted += await upsertBatch(db, parsed, sweepId);

    offset += PAGE_SIZE;
    status.offset = offset;
    await stateSet(db, 'catalog_offset', offset);

    const done = Math.max(1, offset);
    const perItem = (Date.now() - sweepStartedMs) / done;
    status.etaMs = Math.max(0, Math.round((total - offset) * perItem));

    if (offset >= total) break;

    await sleep(REQUEST_INTERVAL_MS);
  }

  // Круг завершён — начинаем следующий с нуля.
  if (offset >= total) {
    await stateSet(db, 'catalog_offset', 0);
    await stateSet(db, 'catalog_last_full_sweep', new Date().toISOString());

    // Снимать с продажи можно ТОЛЬКО по итогам круга, пройденного целиком.
    // Продолженный после рестарта круг видел лишь хвост каталога, и его начало
    // осталось бы непомеченным — пометка снесла бы половину каталога.
    if (fullSweep) {
      const r = await run(db, `UPDATE items SET delisted = 1
                               WHERE (last_sweep_id IS NULL OR last_sweep_id < ?) AND delisted = 0`, [sweepId]);
      if (r && r.changes) console.log(`[Catalog] Круг ${sweepId} завершён, снято с продажи: ${r.changes}`);
    } else {
      console.log(`[Catalog] Круг был продолжен с позиции ${resumeAt} — снятие с продажи пропущено`);
    }
  }

  status.lastSweepFinishedAt = new Date().toISOString();
  status.lastSweepDurationMs = Date.now() - sweepStartedMs;
  status.phase = 'idle';
  status.etaMs = null;
}

/** Непрерывный цикл: круг → пауза → круг. Вызывается один раз при старте. */
async function startWorker() {
  if (status.running) return;
  status.running = true;
  stopRequested = false;

  const totalPages = Math.ceil(5430 / PAGE_SIZE);
  const sweepMin = Math.round((totalPages * REQUEST_INTERVAL_MS) / 60000);
  console.log(`[Catalog] Воркер запущен: ${PAGE_SIZE} поз./запрос, интервал ${REQUEST_INTERVAL_MS} мс`);
  console.log(`[Catalog] Полный круг ≈ ${totalPages} запросов ≈ ${sweepMin} мин`);

  while (!stopRequested) {
    const db = openDb();
    if (!db) {
      console.error('[Catalog] База недоступна, повтор через 60 с');
      await sleep(60000);
      continue;
    }
    try {
      await runSweep(db);
    } catch (e) {
      status.lastError = e.message;
      status.phase = 'error';
      console.error('[Catalog] Ошибка круга:', e.message);
    } finally {
      db.close();
    }
    if (stopRequested) break;
    await sleep(SWEEP_PAUSE_MS);
  }

  status.running = false;
  status.phase = 'stopped';
}

function stopWorker() {
  stopRequested = true;
}

// ---------------------------------------------------------------------------
// Чтение каталога для API
// ---------------------------------------------------------------------------

/** Сводка по редкостям — для админки и фильтров на сайте. */
async function getRarityBreakdown() {
  const db = openDb();
  if (!db) return [];
  await ensureCatalogSchema(db);
  const rows = await all(db, `
    SELECT rarity,
           COUNT(*)  AS count,
           MIN(price) AS minPrice,
           MAX(price) AS maxPrice,
           ROUND(AVG(price)) AS avgPrice
    FROM items WHERE delisted = 0
    GROUP BY rarity`);
  db.close();
  const order = ['REGULAR', 'UNUSUAL', 'RARE', 'VIOLET', 'GOLD'];
  return rows
    .map(r => ({ ...r, color: '#' + (RARITY_HEX[r.rarity] || RARITY_HEX.REGULAR) }))
    .sort((a, b) => order.indexOf(a.rarity) - order.indexOf(b.rarity));
}

/** Постраничная выдача каталога с фильтрами. */
async function queryItems({ rarity, minPrice, maxPrice, search, limit = 100, offset = 0, includeDelisted = false, sort = 'desc' } = {}) {
  const db = openDb();
  if (!db) return { items: [], total: 0 };
  await ensureCatalogSchema(db);

  const where = [];
  const params = [];
  if (!includeDelisted) where.push('delisted = 0');
  if (rarity) { where.push('rarity = ?'); params.push(String(rarity).toUpperCase()); }
  if (minPrice != null) { where.push('price >= ?'); params.push(Number(minPrice)); }
  if (maxPrice != null) { where.push('price <= ?'); params.push(Number(maxPrice)); }
  if (search) { where.push('(name LIKE ? OR market_hash_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  // Направление сортировки подставляется из белого списка, а не из параметра —
  // ORDER BY нельзя передать плейсхолдером, а склейка чужой строки в SQL это
  // инъекция.
  const dir = String(sort).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const totalRow = await get(db, `SELECT COUNT(*) AS c FROM items${sql}`, params);
  const rows = await all(db,
    `SELECT * FROM items${sql} ORDER BY price ${dir}, id ASC LIMIT ? OFFSET ?`,
    [...params, Math.min(Number(limit) || 100, 1000), Number(offset) || 0]);
  db.close();

  return {
    total: totalRow ? totalRow.c : rows.length,
    items: rows.map(r => ({
      id: `db-${r.id}`,
      name: r.name || r.market_hash_name,
      marketHashName: r.market_hash_name,
      price: r.price,
      priceText: `${r.price} ₽`,
      priceUsd: r.price_usd_cents ? +(r.price_usd_cents / 100).toFixed(2) : null,
      image: r.image,
      rarity: r.rarity,
      steamTier: r.steam_tier || null,
      colorHex: r.color ? (String(r.color).startsWith('#') ? r.color : `#${r.color}`) : '#756767',
      sellListings: r.sell_listings || 0,
      upgraderEnabled: r.upgraderEnabled === 1,
      delisted: r.delisted === 1,
      updatedAt: r.updated_at
    }))
  };
}

module.exports = {
  startWorker,
  stopWorker,
  getStatus,
  runSweep,
  queryItems,
  getRarityBreakdown,
  ensureCatalogSchema,
  normalizeLegacyRarities,
  classifyRarity,
  refreshFxRate,
  // Нужен модулю цен из steamdataapi: там те же центы USD.
  usdCentsToRub,
  openDb,
  COLOR_TO_RARITY,
  RARITY_HEX,
  PAGE_SIZE,
  REQUEST_INTERVAL_MS
};
