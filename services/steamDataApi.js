'use strict';

/**
 * Цены и картинки из steamdataapi.com.
 *
 * Зачем: обход Steam Market в steamCatalog.js берёт страницы по 10 предметов —
 * это 543 запроса и около 27 минут на круг, с паузой 3 секунды, иначе бан по IP.
 * Здесь весь каталог Rust приходит ОДНИМ запросом, а цены на стороне сервиса
 * обновляются каждые пять минут.
 *
 *   GET /api/v1/items/all?game=rust&images=1
 *   Authorization: Bearer sdk_…
 *
 * Чего здесь НЕТ и почему обход Steam остаётся нужен:
 *
 *   Редкости. В /items/all её не отдают — она есть только в ответах коллекций
 *   и инвентаря. А в этом проекте редкость берётся из `name_color` Steam
 *   Market, и определять её по цене нельзя: диапазоны цветов перекрываются
 *   почти полностью, на этом уже обжигались.
 *
 * Отсюда разделение обязанностей:
 *   steamCatalog.js  — находит новые предметы и задаёт редкость. Редко.
 *   этот модуль      — обновляет цены и картинки. Часто.
 *
 * Цены приходят в минорных единицах USD (центах), как и у Steam, поэтому
 * пересчёт в рубли делается тем же usdCentsToRub.
 */

const API_URL = String(process.env.STEAMDATA_API_URL || 'https://steamdataapi.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.STEAMDATA_API_KEY || '';

/**
 * Какое поле цены брать.
 *
 *   best      — лучшее предложение по всем площадкам. Самое низкое, но одна
 *               странная выставка утянет цену предмета вниз.
 *   median    — медиана. Устойчива к выбросам, поэтому по умолчанию она.
 *   latest    — последняя сделка.
 *   real      — фактическая цена продажи по данным площадки.
 *
 * Выбор влияет на всю экономику: от цены предмета зависят выплаты и RTP.
 * Прежде чем менять, стоит прогнать сравнение (deploy/prices.js --dry-run).
 */
const PRICE_FIELD = String(process.env.STEAMDATA_PRICE_FIELD || 'median').toLowerCase();

/** Порядок отката, если выбранного поля у предмета нет. */
const FALLBACK_ORDER = ['median', 'real', 'realmedian', 'latest', 'best', 'buyorder'];

function isConfigured() {
  return Boolean(API_KEY);
}

/** Достать цену в центах из объекта prices с учётом отката. */
function pickPrice(prices) {
  if (!prices || typeof prices !== 'object') return 0;
  const lower = {};
  for (const [k, v] of Object.entries(prices)) lower[k.toLowerCase()] = v;

  const order = [PRICE_FIELD, ...FALLBACK_ORDER.filter(f => f !== PRICE_FIELD)];
  for (const key of order) {
    const v = Number(lower[key]);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return 0;
}

/**
 * Весь каталог одним запросом.
 * @returns {{ok:boolean, items?:Array, cachedAt?:string, message?:string}}
 */
async function fetchAll({ game = 'rust', images = true } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'NOT_CONFIGURED', message: 'STEAMDATA_API_KEY не задан' };
  }
  const url = `${API_URL}/items/all?game=${encodeURIComponent(game)}${images ? '&images=1' : ''}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
      // Каталог большой, ответ идёт несколько секунд.
      signal: AbortSignal.timeout(120000)
    });
    const text = await r.text();
    if (!r.ok) {
      console.error(`[SteamData] GET /items/all -> ${r.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: r.status, error: 'API_ERROR', message: `HTTP ${r.status}` };
    }
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, error: 'BAD_JSON', message: 'Ответ не разобрался' }; }

    const items = Array.isArray(body?.data) ? body.data : [];
    return { ok: true, items, cachedAt: body?.cachedAt || null, currency: body?.currency || 'USD', count: items.length };
  } catch (e) {
    console.error(`[SteamData] ${e.message}`);
    return { ok: false, error: 'NETWORK', message: e.message };
  }
}

/**
 * Обновить цены и картинки в каталоге.
 *
 * Редкость и цвет НЕ трогаются: их источник — обход Steam Market.
 * Новые предметы здесь тоже не заводятся — без редкости запись была бы
 * неполной, и она бы попала в кейсы серой. Пусть их находит steamCatalog.
 *
 * @param {boolean} opts.dryRun только посчитать расхождения, ничего не писать
 */
async function refreshPrices({ db, run, all, usdCentsToRub, dryRun = false } = {}) {
  const res = await fetchAll();
  if (!res.ok) return { ok: false, ...res };

  const known = await all(db, `SELECT market_hash_name, price, price_usd_cents, image FROM items`);
  const byName = new Map(known.map(r => [r.market_hash_name, r]));

  let updated = 0, imagesFixed = 0, skipped = 0, unknown = 0;
  let sumOld = 0, sumNew = 0, grew = 0, fell = 0;
  const biggest = [];

  for (const it of res.items) {
    const name = it.marketHashName || it.market_hash_name;
    if (!name) continue;
    const row = byName.get(name);
    if (!row) { unknown++; continue; }

    const cents = pickPrice(it.prices);
    if (!cents) { skipped++; continue; }

    const rub = usdCentsToRub(cents);
    const oldRub = Number(row.price) || 0;

    sumOld += oldRub;
    sumNew += rub;
    if (rub > oldRub) grew++; else if (rub < oldRub) fell++;

    if (oldRub > 0) {
      const diff = Math.abs(rub - oldRub) / oldRub;
      if (diff > 0.2) biggest.push({ name, oldRub, rub, diff: Math.round(diff * 100) });
    }

    // Картинку ставим, только если своей нет: у нас хранится icon_hash со
    // Steam, и подменять рабочую ссылку чужой незачем.
    const img = it.image?.url || null;
    const needImage = img && (!row.image || row.image === '/assets/uploaded-placeholder.png');

    if (!dryRun) {
      await run(db,
        `UPDATE items SET price = ?, price_usd_cents = ?, updated_at = CURRENT_TIMESTAMP
                          ${needImage ? ', image = ?' : ''}
          WHERE market_hash_name = ?`,
        needImage ? [rub, cents, img, name] : [rub, cents, name]);
    }
    updated++;
    if (needImage) imagesFixed++;
  }

  biggest.sort((a, b) => b.diff - a.diff);

  return {
    ok: true,
    dryRun,
    fromApi: res.items.length,
    inCatalog: known.length,
    updated,
    imagesFixed,
    skipped,
    unknown,
    priceField: PRICE_FIELD,
    cachedAt: res.cachedAt,
    grew, fell,
    sumOld: Math.round(sumOld),
    sumNew: Math.round(sumNew),
    shiftPercent: sumOld > 0 ? Math.round(((sumNew - sumOld) / sumOld) * 1000) / 10 : 0,
    biggest: biggest.slice(0, 15)
  };
}

module.exports = { isConfigured, fetchAll, refreshPrices, pickPrice, PRICE_FIELD, API_URL };
