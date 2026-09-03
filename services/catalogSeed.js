'use strict';

/**
 * Наполнение каталога предметов из rust.tm.
 *
 * Что откуда:
 *
 *   rust.tm   имя, цена в рублях, classid, цвет редкости   (services/rustTm.js)
 *   Steam     только картинка, по classid                  (GetAssetClassInfo)
 *
 * Зачем отдельно от steamCatalog.js: тот обходит Steam Market постранично, по
 * 10 позиций за запрос — 543 запроса, около получаса на круг, и Steam на нём
 * отдаёт 429. Здесь список берётся у rust.tm одним запросом, а у Steam
 * спрашиваются только иконки, причём по 100 предметов за раз: около 4900
 * предметов укладываются в полсотни запросов и пару минут.
 *
 * ПОЧЕМУ РЕДКОСТЬ БЕРЁТСЯ ИЗ rust.tm, А НЕ ИЗ STEAM
 *
 * Раньше цвет редкости приходилось спрашивать у Steam вместе с картинкой:
 * в выгрузке lis-skins его не было. У rust.tm он есть в поле text_color и
 * совпадает с name_color Steam — те же четыре значения, что знает
 * COLOR_TO_RARITY. Значит Steam нужен только ради иконки, и если он ответит
 * отказом, предмет всё равно заведётся с правильной редкостью и ценой,
 * просто без картинки.
 *
 * Ключ Steam (STEAM_API_KEY) поэтому теперь необязателен: без него каталог
 * соберётся, но предметы останутся без изображений.
 */

const catalog = require('./steamCatalog');
const rustTm = require('./rustTm');

const APPID = Number(process.env.STEAM_APPID || 252490);
const IMAGE_BASE = 'https://community.cloudflare.steamstatic.com/economy/image/';

/** Сколько классов спрашивать у Steam за раз. 100 — проверенный предел. */
const BATCH = Number(process.env.SEED_BATCH || 100);

/** Пауза между запросами к Steam. GetAssetClassInfo мягче Market, но не безлимитен. */
const BATCH_INTERVAL_MS = Number(process.env.SEED_INTERVAL_MS || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (db, sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (db, sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));

// ---------------------------------------------------------------------------
// Список предметов
// ---------------------------------------------------------------------------

/** Каталог rust.tm: имя, цена, classid, цвет редкости. */
async function fetchCatalogList() {
  const res = await rustTm.fetchCatalog();
  if (!res.ok) return { ok: false, message: res.message || 'rust.tm недоступен' };
  return {
    ok: true,
    items: res.items,
    count: res.count,
    capped: res.capped,
    fromAvg: res.fromAvg,
    noPrice: res.noPrice,
    priceField: res.priceField,
    updatedAt: res.updatedAt
  };
}

// ---------------------------------------------------------------------------
// Картинки из Steam
// ---------------------------------------------------------------------------

/**
 * Спросить у Steam описания классов пачкой.
 *
 * Ответ — объект вида { "2549888174": {...}, "success": true }. Классы, которых
 * Steam не знает, просто отсутствуют в ответе, а `success` при этом становится
 * false — поэтому по нему судить нельзя, смотрим на сами ключи.
 */
async function fetchClassInfo(apiKey, classids) {
  const params = new URLSearchParams({
    key: apiKey,
    appid: String(APPID),
    class_count: String(classids.length)
  });
  classids.forEach((c, i) => params.set(`classid${i}`, c));

  let res;
  try {
    res = await fetch(
      `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v1/?${params}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) }
    );
  } catch (e) {
    return { ok: false, status: 0, message: e.message };
  }
  if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };

  let body;
  try { body = await res.json(); } catch { return { ok: false, status: 200, message: 'не JSON' }; }

  const result = body?.result;
  if (!result || typeof result !== 'object') return { ok: false, status: 200, message: 'пустой result' };

  const byClass = new Map();
  for (const [k, v] of Object.entries(result)) {
    if (k === 'success' || !v || typeof v !== 'object') continue;
    byClass.set(String(k), v);
  }
  return { ok: true, byClass };
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

/**
 * Заводит и обновляет строки items.
 *
 * Форма записи совпадает с обходом Market (steamCatalog): те же колонки, тот же
 * ON CONFLICT по market_hash_name. Поэтому предметы, заведённые здесь, обход
 * потом просто обновит, не задвоив.
 *
 * image пишется через COALESCE: если картинки у нас нет (Steam не ответил), у
 * уже существующего предмета она НЕ затирается пустотой.
 *
 * delisted = 0: раз вещь есть в выгрузке, она продаётся.
 */
async function writeItem(db, it) {
  return run(db, `
    INSERT INTO items (market_hash_name, name, price, rarity, color, image,
                       upgraderEnabled, price_usd_cents, rarity_color, steam_tier,
                       sell_listings, classid, icon_hash, delisted,
                       last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(market_hash_name) DO UPDATE SET
      name            = excluded.name,
      price           = excluded.price,
      rarity          = excluded.rarity,
      color           = excluded.color,
      image           = COALESCE(NULLIF(excluded.image, ''), items.image),
      rarity_color    = excluded.rarity_color,
      steam_tier      = excluded.steam_tier,
      sell_listings   = excluded.sell_listings,
      classid         = excluded.classid,
      icon_hash       = COALESCE(NULLIF(excluded.icon_hash, ''), items.icon_hash),
      delisted        = 0,
      last_seen_at    = CURRENT_TIMESTAMP,
      updated_at      = CURRENT_TIMESTAMP
  `, [it.marketHashName, it.name, it.priceRub, it.rarity, it.hex, it.image,
      it.rarityColor, it.steamTier, it.sellListings, it.classid, it.iconHash]);
}

// ---------------------------------------------------------------------------
// Основное
// ---------------------------------------------------------------------------

/**
 * Собрать каталог целиком.
 *
 * @param {object}   opts.db         открытая база (админская)
 * @param {string}   opts.apiKey     ключ Steam; без него не будет картинок
 * @param {boolean}  opts.dryRun     ничего не писать, только посчитать
 * @param {number}   opts.limit      ограничить число предметов (для проверки)
 * @param {Function} opts.onProgress ({done, total, written}) => void
 */
async function seed({ db, apiKey, dryRun = false, limit = 0, onProgress } = {}) {
  const list = await fetchCatalogList();
  if (!list.ok) return list;

  let items = list.items;
  if (limit > 0) items = items.slice(0, limit);

  await catalog.ensureCatalogSchema(db);

  const before = await all(db, `SELECT COUNT(*) AS n FROM items`);

  let written = 0, created = 0, updated = 0;
  let noImage = 0, failedBatches = 0;
  const known = new Set(
    (await all(db, `SELECT market_hash_name FROM items WHERE market_hash_name IS NOT NULL`))
      .map(r => String(r.market_hash_name).toLowerCase())
  );

  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);

    // Картинки — единственное, ради чего нужен Steam. Нет ключа или Steam не
    // ответил — заводим предметы без изображений: цена и редкость уже есть.
    let info = null;
    if (apiKey) {
      const r = await fetchClassInfo(apiKey, chunk.map(c => c.classid));
      if (r.ok) info = r.byClass;
      else {
        failedBatches++;
        // 429 — Steam просит подождать; остальное чаще всего разовый сбой сети.
        await sleep(r.status === 429 ? 10000 : BATCH_INTERVAL_MS);
      }
    }

    for (const src of chunk) {
      const ad = info ? info.get(src.classid) : null;
      const iconHash = ad?.icon_url || '';
      if (!iconHash) noImage++;

      // Редкость из цвета rust.tm. Цену передаём, потому что верхний тир
      // (GOLD) в этом проекте определяется порогом цены, а не цветом Steam.
      const cls = catalog.classifyRarity(src.nameColor, src.priceRub);

      const row = {
        marketHashName: src.marketHashName,
        name: src.name || src.marketHashName,
        priceRub: src.priceRub,
        rarity: cls.rarity,
        hex: cls.hex,
        rarityColor: cls.steamColor,
        steamTier: cls.steamTier,
        image: iconHash ? IMAGE_BASE + iconHash : '',
        iconHash,
        classid: src.classid,
        // Сколько лотов было за неделю — ближайшее к «сколько предложений».
        sellListings: src.popularity7d || 0
      };

      if (!dryRun) {
        try {
          await writeItem(db, row);
        } catch (e) {
          // Единичная строка не должна ронять весь проход.
          console.error(`[Seed] ${row.marketHashName}: ${e.message}`);
          continue;
        }
      }
      if (known.has(row.marketHashName.toLowerCase())) updated++; else created++;
      known.add(row.marketHashName.toLowerCase());
      written++;
    }

    if (typeof onProgress === 'function') {
      onProgress({ done: Math.min(i + BATCH, items.length), total: items.length, written });
    }
    if (apiKey && i + BATCH < items.length) await sleep(BATCH_INTERVAL_MS);
  }

  const after = await all(db, `SELECT COUNT(*) AS n FROM items`);

  return {
    ok: true,
    dryRun,
    source: 'rust.tm',
    unique: items.length,
    written, created, updated,
    noImage, failedBatches,
    capped: list.capped,
    fromAvg: list.fromAvg,
    noPrice: list.noPrice,
    priceField: list.priceField,
    hadSteamKey: Boolean(apiKey),
    countBefore: before[0]?.n ?? 0,
    countAfter: after[0]?.n ?? 0,
    updatedAt: list.updatedAt
  };
}

module.exports = { seed, fetchCatalogList, fetchClassInfo, BATCH };
