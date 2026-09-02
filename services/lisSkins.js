'use strict';

/**
 * Цены предметов из lis-skins.com.
 *
 * Почему именно он: ключ не нужен вовсе, весь каталог Rust приходит одним
 * запросом, и это живые цены торговой площадки. Для сравнения, обход Steam
 * Market в steamCatalog.js берёт страницы по 10 позиций — 543 запроса и около
 * получаса на круг, с риском бана по IP.
 *
 *   GET https://lis-skins.com/market_export_json/rust.json
 *   -> [{ name, price, unlocked_price, url, count }, …]  примерно 4600 записей
 *
 * Есть и полная выгрузка api_rust_full.json на 16 МБ, но это перечень
 * отдельных лотов (76 тысяч), а не каталог: одна и та же вещь встречается
 * десятки раз. Нам нужна цена за предмет, поэтому берём короткую.
 *
 * Чего здесь НЕТ, и поэтому обход Steam остаётся нужен:
 *
 *   Картинок и редкости. Ни в короткой выгрузке, ни в полной их нет — в
 *   полной есть item_class_id, но по нему картинку Steam не собрать, для неё
 *   нужен icon_url. А редкость в этом проекте берётся из name_color Steam
 *   Market: выводить её из цены нельзя, диапазоны цветов перекрываются.
 *
 * Отсюда разделение: steamCatalog находит предметы и задаёт им редкость с
 * картинкой, этот модуль обновляет цены. Новые предметы отсюда не заводятся —
 * без редкости запись была бы неполной, и предмет попал бы в кейсы серым.
 *
 * Цены в выгрузке — доллары (Glory AK47 около 236, Tempered AK47 около 9),
 * поэтому пересчёт в рубли идёт тем же курсом, что и у каталога Steam.
 */

const API_URL = String(process.env.LISSKINS_URL || 'https://lis-skins.com/market_export_json/rust.json');

/**
 * Какую цену брать, когда у предмета есть и обычная, и разблокированная.
 * `price` — с учётом возможной блокировки трейда, `unlocked_price` — сразу
 * доступный лот, он дороже. По умолчанию берём обычную: она ближе к тому,
 * во сколько предмет реально обходится.
 */
const PRICE_FIELD = String(process.env.LISSKINS_PRICE_FIELD || 'price').toLowerCase();

function isConfigured() {
  // Ключа не требуется — источник доступен всегда.
  return true;
}

function pickPrice(item) {
  const primary = Number(item?.[PRICE_FIELD]);
  if (Number.isFinite(primary) && primary > 0) return primary;
  for (const k of ['price', 'unlocked_price']) {
    const v = Number(item?.[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** Весь каталог одним запросом. */
async function fetchAll() {
  try {
    const r = await fetch(API_URL, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(120000)
    });
    if (!r.ok) {
      console.error(`[LisSkins] GET -> ${r.status}`);
      if (r.status === 403) {
        console.error('[LisSkins] 403 — выгрузка открыта без ключа, значит режет');
        console.error('[LisSkins] защита площадки по адресу сервера. Проверьте');
        console.error(`[LisSkins] с самого сервера: curl -I ${API_URL}`);
      }
      return { ok: false, status: r.status, error: 'API_ERROR', message: `HTTP ${r.status}` };
    }
    const body = await r.json();
    // Короткая выгрузка — просто массив; у полной items лежит внутри объекта.
    const items = Array.isArray(body) ? body : (Array.isArray(body?.items) ? body.items : []);
    if (!items.length) return { ok: false, error: 'EMPTY', message: 'Выгрузка пуста' };

    return { ok: true, items, count: items.length, updatedAt: body?.last_update || null };
  } catch (e) {
    console.error(`[LisSkins] ${e.message}`);
    return { ok: false, error: 'NETWORK', message: e.message };
  }
}

/**
 * Обновить цены каталога.
 *
 * Редкость, цвет и картинки не трогаются: их источник — обход Steam Market.
 * Новые предметы не заводятся по той же причине.
 *
 * @param {boolean} opts.dryRun только посчитать расхождения, ничего не писать
 */
async function refreshPrices({ db, run, all, usdToRub, dryRun = false } = {}) {
  const res = await fetchAll();
  if (!res.ok) return { ok: false, ...res };

  const known = await all(db, `SELECT market_hash_name, name, price FROM items`);
  // Сопоставляем и по market_hash_name, и по name: в выгрузке имя без
  // указания износа, а у нас в каталоге встречается и то и другое.
  const byName = new Map();
  for (const r of known) {
    if (r.market_hash_name) byName.set(String(r.market_hash_name).toLowerCase(), r);
    if (r.name && !byName.has(String(r.name).toLowerCase())) {
      byName.set(String(r.name).toLowerCase(), r);
    }
  }

  let updated = 0, skipped = 0, unknown = 0, grew = 0, fell = 0;
  let sumOld = 0, sumNew = 0;
  const biggest = [];
  const seen = new Set();

  for (const it of res.items) {
    const name = String(it?.name || '').trim();
    if (!name) continue;
    const row = byName.get(name.toLowerCase());
    if (!row) { unknown++; continue; }
    // Одна вещь может встретиться несколько раз — берём первое вхождение.
    if (seen.has(row.market_hash_name)) continue;
    seen.add(row.market_hash_name);

    const usd = pickPrice(it);
    if (!usd) { skipped++; continue; }

    const rub = usdToRub(usd);
    const oldRub = Number(row.price) || 0;
    sumOld += oldRub;
    sumNew += rub;
    if (rub > oldRub) grew++; else if (rub < oldRub) fell++;

    if (oldRub > 0) {
      const diff = Math.abs(rub - oldRub) / oldRub;
      if (diff > 0.2) biggest.push({ name, oldRub, rub, diff: Math.round(diff * 100) });
    }

    if (!dryRun) {
      await run(db,
        `UPDATE items SET price = ?, price_usd_cents = ?, updated_at = CURRENT_TIMESTAMP
          WHERE market_hash_name = ?`,
        [rub, Math.round(usd * 100), row.market_hash_name]);
    }
    updated++;
  }

  biggest.sort((a, b) => b.diff - a.diff);

  return {
    ok: true,
    source: 'lis-skins',
    dryRun,
    fromApi: res.items.length,
    inCatalog: known.length,
    updated, skipped, unknown,
    priceField: PRICE_FIELD,
    updatedAt: res.updatedAt,
    grew, fell,
    sumOld: Math.round(sumOld),
    sumNew: Math.round(sumNew),
    shiftPercent: sumOld > 0 ? Math.round(((sumNew - sumOld) / sumOld) * 1000) / 10 : 0,
    biggest: biggest.slice(0, 15)
  };
}

module.exports = { isConfigured, fetchAll, refreshPrices, pickPrice, API_URL, PRICE_FIELD };
