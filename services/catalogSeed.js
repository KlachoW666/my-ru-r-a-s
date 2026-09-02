'use strict';

/**
 * Заполнение каталога предметов из lis-skins + Steam.
 *
 * Зачем отдельно от steamCatalog.js: тот обходит Steam Market постранично, по
 * 10 позиций за запрос — 543 запроса, около получаса на круг, и Steam на нём
 * отдаёт 429. Здесь список берётся у lis-skins одним запросом, а у Steam
 * спрашиваются только картинка и цвет редкости, причём по 100 предметов за
 * запрос: 4590 предметов укладываются в 46 запросов и пару минут.
 *
 * Откуда что берётся:
 *
 *   lis-skins  api_rust_full.json   -> name, price (USD), item_class_id
 *   Steam      GetAssetClassInfo    -> icon_url, name_color, market_hash_name
 *
 * Связующее звено — item_class_id: это и есть classid Steam. Короткая выгрузка
 * market_export_json/rust.json его не содержит, поэтому здесь берётся полная,
 * на 16 МБ.
 *
 * Полная выгрузка — перечень отдельных лотов (около 76 тысяч), а не каталог:
 * одна и та же вещь встречается десятками. Схлопываем по classid, оставляя
 * минимальную цену — по ней предмет реально можно купить.
 *
 * Редкость выводится из name_color ровно так же, как при обходе Market
 * (classifyRarity), поэтому предметы, заведённые отсюда и обходом, неразличимы.
 * Из цены редкость не выводится: диапазоны цветов перекрываются.
 *
 * GetAssetClassInfo требует Steam API-ключ (STEAM_API_KEY). Без него список
 * получить можно, но без картинок и редкости, и такие предметы попали бы в
 * кейсы серыми — поэтому без ключа сидер отказывается работать.
 */

const catalog = require('./steamCatalog');
const lisApi = require('./lisSkinsApi');

const FULL_URL = String(process.env.LISSKINS_FULL_URL
  || 'https://lis-skins.com/market_export_json/api_rust_full.json');

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

/**
 * Полная выгрузка lis-skins, схлопнутая до каталога.
 *
 * @returns {Promise<{ok: boolean, items?: Array, message?: string}>}
 *          items: [{ classid, name, usd }]
 */
/**
 * Список предметов: сначала открытая выгрузка, при отказе — официальный API.
 *
 * Открытая выгрузка ключа не требует и приходит одним запросом, поэтому она
 * первая. Но защита площадки режет её по адресу клиента: рабочему серверу она
 * отвечает 403 даже с браузерными заголовками. Хост api.lis-skins.com с того
 * же сервера доступен, так что при 403 переходим на него — если задан
 * LISSKINS_API_KEY.
 */
async function fetchCatalogList() {
  const direct = await fetchExport();
  if (direct.ok) return direct;

  if (!lisApi.isConfigured()) {
    return {
      ok: false,
      message: direct.message
             + '. Открытая выгрузка недоступна с этого адреса — задайте '
             + 'LISSKINS_API_KEY в .env, и список пойдёт через официальный API'
    };
  }

  console.log(`[Seed] Выгрузка недоступна (${direct.message}), беру список через API`);
  const viaApi = await lisApi.fetchCatalogList({
    onPage: ({ page, got, total }) =>
      console.log(`[Seed] Страница ${page}: ${got} записей, уникальных ${total}`)
  });
  if (!viaApi.ok) return viaApi;
  return { ...viaApi, noClass: 0, noPrice: 0, updatedAt: null };
}

/** Открытая выгрузка одним запросом. Ключа не требует, но режется по адресу. */
async function fetchExport() {
  let body;
  try {
    const r = await fetch(FULL_URL, {
      // Тот же браузерный набор, что и в lisSkins: Node-овский User-Agent
      // защита площадки оценивает строже.
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      },
      // 16 МБ по медленному каналу: минуты на скачивание — норма.
      signal: AbortSignal.timeout(180000)
    });
    if (!r.ok) return { ok: false, message: `lis-skins ответил HTTP ${r.status}` };
    body = await r.json();
  } catch (e) {
    return { ok: false, message: `lis-skins недоступен: ${e.message}` };
  }

  const rows = Array.isArray(body) ? body : (Array.isArray(body?.items) ? body.items : []);
  if (!rows.length) return { ok: false, message: 'Выгрузка пуста' };

  const byClass = new Map();
  let noClass = 0, noPrice = 0;

  for (const it of rows) {
    const classid = String(it?.item_class_id || '').trim();
    if (!classid) { noClass++; continue; }
    const usd = Number(it?.price);
    if (!Number.isFinite(usd) || usd <= 0) { noPrice++; continue; }

    const prev = byClass.get(classid);
    // Минимальная цена: столько предмет и стоит на площадке.
    if (!prev || usd < prev.usd) {
      byClass.set(classid, { classid, name: String(it?.name || '').trim(), usd });
    }
  }

  return {
    ok: true,
    items: [...byClass.values()],
    lots: rows.length,
    noClass,
    noPrice,
    updatedAt: body?.last_update || null
  };
}

// ---------------------------------------------------------------------------
// Картинки и редкость из Steam
// ---------------------------------------------------------------------------

/**
 * Спросить у Steam описания классов пачкой.
 *
 * Ответ — объект вида { "2549888174": {...}, "success": true }. Классы, которых
 * Steam не знает, просто отсутствуют в ответе, а `success` при этом становится
 * false — поэтому по нему судить нельзя, смотрим на сами ключи.
 *
 * @returns {Promise<{ok: boolean, byClass?: Map, status?: number}>}
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
 * Форма записи совпадает с обходом Market (steamCatalog.upsert): те же колонки,
 * тот же ON CONFLICT по market_hash_name. Поэтому предметы, заведённые здесь,
 * обход потом просто обновит, не задвоив.
 *
 * delisted = 0: раз вещь есть в выгрузке, она продаётся.
 */
async function writeItem(db, it) {
  const r = await run(db, `
    INSERT INTO items (market_hash_name, name, price, rarity, color, image,
                       upgraderEnabled, price_usd_cents, rarity_color, steam_tier,
                       sell_listings, classid, icon_hash, delisted,
                       last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(market_hash_name) DO UPDATE SET
      name            = excluded.name,
      price           = excluded.price,
      rarity          = excluded.rarity,
      color           = excluded.color,
      image           = excluded.image,
      price_usd_cents = excluded.price_usd_cents,
      rarity_color    = excluded.rarity_color,
      steam_tier      = excluded.steam_tier,
      classid         = excluded.classid,
      icon_hash       = excluded.icon_hash,
      delisted        = 0,
      last_seen_at    = CURRENT_TIMESTAMP,
      updated_at      = CURRENT_TIMESTAMP
  `, [it.marketHashName, it.name, it.priceRub, it.rarity, it.hex, it.image,
      it.usdCents, it.rarityColor, it.steamTier, it.sellListings, it.classid,
      it.iconHash]);
  return r;
}

// ---------------------------------------------------------------------------
// Основное
// ---------------------------------------------------------------------------

/**
 * Собрать каталог целиком.
 *
 * @param {object}   opts.db        открытая база (админская)
 * @param {string}   opts.apiKey    Steam API-ключ
 * @param {boolean}  opts.dryRun    ничего не писать, только посчитать
 * @param {number}   opts.limit     ограничить число предметов (для проверки)
 * @param {Function} opts.onProgress ({done, total, written}) => void
 */
async function seed({ db, apiKey, dryRun = false, limit = 0, onProgress } = {}) {
  if (!apiKey) {
    return { ok: false, message: 'Нужен STEAM_API_KEY: без него нет картинок и редкости' };
  }

  const list = await fetchCatalogList();
  if (!list.ok) return list;

  let items = list.items;
  if (limit > 0) items = items.slice(0, limit);

  await catalog.ensureCatalogSchema(db);
  // Цены в выгрузке долларовые — курс нужен до пересчёта.
  await catalog.refreshFxRate();

  const before = await all(db, `SELECT COUNT(*) AS n FROM items`);

  let written = 0, created = 0, updated = 0;
  let noInfo = 0, failedBatches = 0;
  const known = new Set(
    (await all(db, `SELECT market_hash_name FROM items WHERE market_hash_name IS NOT NULL`))
      .map(r => String(r.market_hash_name).toLowerCase())
  );

  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const info = await fetchClassInfo(apiKey, chunk.map(c => c.classid));

    if (!info.ok) {
      failedBatches++;
      // 429 — Steam просит подождать; остальное чаще всего разовый сбой сети.
      await sleep(info.status === 429 ? 10000 : BATCH_INTERVAL_MS);
      continue;
    }

    for (const src of chunk) {
      const ad = info.byClass.get(src.classid);
      if (!ad) { noInfo++; continue; }

      const iconHash = ad.icon_url || '';
      const marketHashName = String(ad.market_hash_name || src.name || '').trim();
      // Без имени запись не найти, без иконки предмет будет пустой плиткой.
      if (!marketHashName || !iconHash) { noInfo++; continue; }

      const usdCents = Math.round(src.usd * 100);
      const priceRub = catalog.usdCentsToRub(usdCents);
      const cls = catalog.classifyRarity(ad.name_color, priceRub);

      const row = {
        marketHashName,
        name: String(ad.name || src.name || marketHashName).trim(),
        priceRub,
        usdCents,
        rarity: cls.rarity,
        hex: cls.hex,
        rarityColor: cls.steamColor,
        steamTier: cls.steamTier,
        image: IMAGE_BASE + iconHash,
        iconHash,
        classid: src.classid,
        // Полная выгрузка не считает лоты по предмету — оставляем ноль,
        // это поле заполнит обход Market.
        sellListings: 0
      };

      if (!dryRun) {
        try {
          await writeItem(db, row);
        } catch (e) {
          // Единичная строка не должна ронять весь проход.
          console.error(`[Seed] ${marketHashName}: ${e.message}`);
          continue;
        }
      }
      if (known.has(marketHashName.toLowerCase())) updated++; else created++;
      known.add(marketHashName.toLowerCase());
      written++;
    }

    if (typeof onProgress === 'function') {
      onProgress({ done: Math.min(i + BATCH, items.length), total: items.length, written });
    }
    if (i + BATCH < items.length) await sleep(BATCH_INTERVAL_MS);
  }

  const after = await all(db, `SELECT COUNT(*) AS n FROM items`);

  return {
    ok: true,
    dryRun,
    lots: list.lots,
    unique: items.length,
    written, created, updated, noInfo, failedBatches,
    countBefore: before[0]?.n ?? 0,
    countAfter: after[0]?.n ?? 0,
    updatedAt: list.updatedAt
  };
}

module.exports = { seed, fetchCatalogList, fetchClassInfo, FULL_URL, BATCH };
