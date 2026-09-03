'use strict';

/**
 * Каталог и цены предметов Rust с rust.tm.
 *
 * Единственный источник скинов в проекте. Заменил lis-skins, у которого цены
 * были долларовые (нужен курс), редкости не было вовсе, а открытая выгрузка
 * резалась по адресу сервера.
 *
 * ЧТО БЕРЁМ
 *
 *   GET https://rust.tm/api/v2/prices/class_instance/RUB.json
 *
 * Ключ не нужен — эндпоинт открыт. Ответ:
 *
 *   { success, time, currency: "RUB", items: {
 *       "620601242_0": {
 *         price, buy_order, avg_price, popularity_7d,
 *         market_hash_name, ru_name, ru_rarity, ru_quality,
 *         text_color, bg_color
 *       }, … } }
 *
 * Замер на 2026-09-02: 4862 позиции, 1.1 МБ.
 *
 * ЧЕМ ЭТОТ ИСТОЧНИК ЛУЧШЕ ПРЕЖНЕГО
 *
 *   Ключ в объекте — это classid_instanceid. classid нужен, чтобы получить
 *   картинку у Steam (GetAssetClassInfo), и здесь он есть сразу.
 *
 *   Цены уже в рублях. Пересчёт по курсу не нужен, а значит нет и целого
 *   класса ошибок, где каталог уезжал вместе с курсом.
 *
 *   text_color — это name_color из Steam, из которого проект и выводит
 *   редкость. Замер: f15840 x1689, 35a3f1 x1631, a7ec2e x1539, dddddd x3 —
 *   ровно четыре цвета, все известны COLOR_TO_RARITY в steamCatalog.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ПОЧЕМУ ОПОРНАЯ ЦЕНА — avg_price, А НЕ price
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `price` — это самое дешёвое ТЕКУЩЕЕ предложение на площадке, а не рыночная
 * цена предмета. Если вещь выставил один человек и заломил цену, price станет
 * такой же. В замере это видно прямо:
 *
 *   Toy Vest              price 200 000 ₽   avg 75,71 ₽   продаж за 7 дней: 1
 *   Peacemaker Sleeping Bag  price 58 966 ₽   avg 82,16 ₽   продаж за 7 дней: 1
 *   максимум по выгрузке  price 40 964 129 ₽
 *
 * Всего таких перекосов (price больше avg_price втрое и сильнее) — 46 из 4862.
 *
 * Для сайта кейсов это не косметика. От цены предмета считаются выплаты и
 * отдача кейса: один предмет с ценой в сорок миллионов делает кейс либо
 * неоткрываемым (сервер заблокирует его как заведомо убыточный), либо
 * разорительным. Поэтому опорной берём avg_price — цену реальных сделок, — а
 * price только когда средней нет.
 *
 * Переключается через RUSTTM_PRICE_FIELD=price, если понадобится обратное.
 */

const API_URL = String(process.env.RUSTTM_PRICES_URL
  || 'https://rust.tm/api/v2/prices/class_instance/RUB.json');

/** Какую цену считать опорной: 'avg' (по умолчанию) или 'price'. */
const PRICE_FIELD = String(process.env.RUSTTM_PRICE_FIELD || 'avg').toLowerCase();

/*
 * ЧТО ДЕЛАТЬ, КОГДА avg_price ОТСУТСТВУЕТ
 *
 * Замер по выгрузке от 2026-09-03 (4862 позиции):
 *
 *   без avg_price                     3033   62% — это основной путь,
 *                                            а не редкий случай
 *   из них с buy_order                3016
 *   без обоих                           17
 *
 * То есть у большинства предметов средней цены нет вовсе, и опираться
 * приходится на price — лучшее текущее предложение. Само по себе оно обычно
 * адекватно, но у части позиций это одиночный лот с выдуманной ценой.
 *
 * Отличить одно от другого позволяет buy_order — сколько за предмет реально
 * готовы заплатить. Разброс price / buy_order по выгрузке:
 *
 *   на позициях, где avg_price ЕСТЬ (здоровые):
 *     медиана 1.92, 90-й перцентиль 3.46, 99-й 27.07
 *   на позициях, где avg_price НЕТ:
 *     медиана 2.20, 90-й перцентиль 4.30, максимум 390 134
 *
 * Медианы почти совпадают: отсутствие средней цены само по себе не признак
 * плохих данных, ломается только хвост. Поэтому порог — 30x, выше 99-го
 * перцентиля здоровых позиций, чтобы не задеть нормальные. Под него попадает
 * около трёх десятков предметов, включая Death Viper с price 40 964 129 ₽
 * при buy_order 105 ₽.
 *
 * Подменяем не на сам buy_order, а на buy_order, умноженный на типичный
 * разброс: buy_order — это цена спроса, нижняя граница, и брать её как
 * рыночную значило бы систематически занижать выплаты.
 */
const SPREAD_LIMIT = Number(process.env.RUSTTM_SPREAD_LIMIT || 30);
const TYPICAL_SPREAD = Number(process.env.RUSTTM_TYPICAL_SPREAD || 2);

/**
 * Во сколько раз price может превышать avg_price, прежде чем мы перестанем
 * ему верить. Замер: по всей выгрузке отношение avg / price имеет медиану
 * 0.85 и максимум 2, то есть avg почти никогда не бывает сильно выше price.
 * Порог нужен для обратного случая — когда price задран над средней.
 */
const OUTLIER_RATIO = Number(process.env.RUSTTM_OUTLIER_RATIO || 3);

/** Потолок цены предмета, ₽. Последняя страховка от мусора в выгрузке. */
const MAX_PRICE_RUB = Number(process.env.RUSTTM_MAX_PRICE_RUB || 100000);

const BROWSER_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

function isConfigured() {
  // Ключа не требуется: эндпоинт цен открыт.
  return true;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Опорная цена предмета в рублях и пометка, откуда она взята.
 *
 * Порядок доверия:
 *   1. avg_price          средняя цена сделок — лучший сигнал
 *   2. price              лучшее предложение, если оно правдоподобно
 *   3. buy_order x спред  когда предложение оторвано от спроса
 *   4. потолок            последняя страховка
 *
 * @returns {{rub: number, source: string}} source: avg | price | buy_order | capped
 */
function pickPrice(v) {
  const best = num(v?.price);
  const avg = num(v?.avg_price);
  const buy = num(v?.buy_order);

  let rub, source;
  if (PRICE_FIELD === 'price') {
    rub = best || avg;
    source = best ? 'price' : 'avg';
  } else {
    rub = avg || best;
    source = avg ? 'avg' : 'price';
  }

  // Обе цены есть, но лучшее предложение неправдоподобно выше средней —
  // верим средней. Это тот самый случай одиночного лота с задранной ценой.
  if (avg && best && best > avg * OUTLIER_RATIO && source === 'price') {
    rub = avg;
    source = 'avg';
  }

  // Средней нет, а предложение оторвано от спроса — считаем цену от спроса.
  // Без этого сюда попадали предметы вроде Death Viper: предложение
  // 40 964 129 ₽ при спросе 105 ₽.
  if (source === 'price' && buy && rub > buy * SPREAD_LIMIT) {
    rub = buy * TYPICAL_SPREAD;
    source = 'buy_order';
  }

  if (rub > MAX_PRICE_RUB) {
    rub = MAX_PRICE_RUB;
    source = 'capped';
  }

  return { rub: Math.round(rub * 100) / 100, source };
}

/** Весь каталог одним запросом. */
async function fetchCatalog() {
  let body;
  try {
    const r = await fetch(API_URL, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(120000)
    });
    if (!r.ok) {
      console.error(`[RustTM] GET -> ${r.status}`);
      return { ok: false, error: 'API_ERROR', message: `HTTP ${r.status}` };
    }
    body = await r.json();
  } catch (e) {
    console.error(`[RustTM] ${e.message}`);
    return { ok: false, error: 'NETWORK', message: e.message };
  }

  const raw = body?.items;
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'EMPTY', message: 'В ответе нет items' };
  }

  const items = [];
  let noPrice = 0;
  // Откуда взялась цена у каждого предмета — по этому счётчику видно, что
  // происходит с выгрузкой, не заглядывая в неё руками.
  const bySource = { avg: 0, price: 0, buy_order: 0, capped: 0 };

  for (const [key, v] of Object.entries(raw)) {
    // Ключ вида "620601242_0" — classid и instanceid.
    const sep = key.indexOf('_');
    const classid = sep === -1 ? key : key.slice(0, sep);
    const instanceid = sep === -1 ? '0' : key.slice(sep + 1);

    const marketHashName = String(v?.market_hash_name || '').trim();
    if (!classid || !marketHashName) continue;

    const { rub, source } = pickPrice(v);
    if (!rub) { noPrice++; continue; }
    bySource[source] = (bySource[source] || 0) + 1;

    items.push({
      classid,
      instanceid,
      marketHashName,
      // ru_name у большинства позиций совпадает с английским именем; берём
      // его, когда оно есть, иначе market_hash_name.
      name: String(v?.ru_name || marketHashName).trim(),
      priceRub: rub,
      priceSource: source,
      bestRub: num(v?.price),
      avgRub: num(v?.avg_price),
      buyOrder: num(v?.buy_order),
      popularity7d: Number(v?.popularity_7d) || 0,
      // Цвет Steam: из него steamCatalog.classifyRarity выводит редкость.
      nameColor: String(v?.text_color || '').trim(),
      quality: String(v?.ru_quality || '').trim()
    });
  }

  if (!items.length) return { ok: false, error: 'EMPTY', message: 'Выгрузка пуста' };

  return {
    ok: true,
    items,
    count: items.length,
    noPrice,
    bySource,
    capped: bySource.capped,
    fromAvg: bySource.avg,
    fromBuyOrder: bySource.buy_order,
    priceField: PRICE_FIELD,
    updatedAt: body?.time ? new Date(body.time * 1000).toISOString() : null
  };
}

/**
 * Обновить цены каталога.
 *
 * Редкость, цвет и картинки не трогаются: этим занимается наполнение каталога
 * (services/catalogSeed.js), а здесь только цены. Новые предметы отсюда не
 * заводятся по той же причине.
 *
 * @param {boolean} opts.dryRun только посчитать расхождения, ничего не писать
 */
async function refreshPrices({ db, run, all, dryRun = false } = {}) {
  const res = await fetchCatalog();
  if (!res.ok) return { ok: false, ...res };

  const known = await all(db, `SELECT market_hash_name, name, price, classid FROM items`);

  // Сопоставляем сначала по classid — он однозначен, — и лишь потом по имени.
  const byClassid = new Map();
  const byName = new Map();
  for (const r of known) {
    if (r.classid) byClassid.set(String(r.classid), r);
    if (r.market_hash_name) byName.set(String(r.market_hash_name).toLowerCase(), r);
    if (r.name && !byName.has(String(r.name).toLowerCase())) {
      byName.set(String(r.name).toLowerCase(), r);
    }
  }

  let updated = 0, unknown = 0, grew = 0, fell = 0;
  let sumOld = 0, sumNew = 0;
  const biggest = [];
  const seen = new Set();

  for (const it of res.items) {
    const row = byClassid.get(it.classid) || byName.get(it.marketHashName.toLowerCase());
    if (!row) { unknown++; continue; }
    if (seen.has(row.market_hash_name)) continue;
    seen.add(row.market_hash_name);

    const rub = it.priceRub;
    const oldRub = Number(row.price) || 0;
    sumOld += oldRub;
    sumNew += rub;
    if (rub > oldRub) grew++; else if (rub < oldRub) fell++;

    if (oldRub > 0) {
      const diff = Math.abs(rub - oldRub) / oldRub;
      if (diff > 0.2) {
        biggest.push({ name: it.marketHashName, oldRub, rub, diff: Math.round(diff * 100) });
      }
    }

    if (!dryRun) {
      await run(db,
        `UPDATE items SET price = ?, updated_at = CURRENT_TIMESTAMP
          WHERE market_hash_name = ?`,
        [rub, row.market_hash_name]);
    }
    updated++;
  }

  biggest.sort((a, b) => b.diff - a.diff);

  return {
    ok: true,
    source: 'rust.tm',
    dryRun,
    fromApi: res.count,
    inCatalog: known.length,
    updated,
    unknown,
    skipped: res.noPrice,
    capped: res.capped,
    fromAvg: res.fromAvg,
    fromBuyOrder: res.fromBuyOrder,
    bySource: res.bySource,
    priceField: res.priceField,
    updatedAt: res.updatedAt,
    grew, fell,
    sumOld: Math.round(sumOld),
    sumNew: Math.round(sumNew),
    shiftPercent: sumOld > 0 ? Math.round(((sumNew - sumOld) / sumOld) * 1000) / 10 : 0,
    biggest: biggest.slice(0, 15)
  };
}

module.exports = {
  isConfigured, fetchCatalog, refreshPrices, pickPrice,
  API_URL, PRICE_FIELD, OUTLIER_RATIO, MAX_PRICE_RUB
};
