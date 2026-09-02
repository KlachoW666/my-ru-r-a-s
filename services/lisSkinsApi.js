'use strict';

/**
 * Официальный API lis-skins — запасной путь, когда открытая выгрузка недоступна.
 *
 * Зачем он нужен. Открытая выгрузка lis-skins.com/market_export_json/*.json
 * ключа не требует, но защита площадки режет её по адресу: с одних машин она
 * отдаётся, а рабочему серверу отвечает 403 даже с браузерными заголовками.
 * Хост api.lis-skins.com при этом с того же сервера доступен — он отвечает
 * осмысленным {"error":"missing_api_key"}, то есть запрос до приложения
 * доходит. Значит вопрос только в ключе.
 *
 * Маршруты определены перебором (существующий путь отвечает 403 missing_api_key,
 * несуществующий — 404):
 *
 *   GET /v1/market/search    список лотов с ценами
 *   GET /v1/market/history   история
 *   GET /v1/user/balance     баланс, годится для проверки ключа
 *
 * ВНИМАНИЕ. Форма ответа /market/search по документации не проверялась:
 * документация отдаётся одностраничным приложением и текстом не читается, а
 * ключа у нас нет. Поэтому разбор здесь намеренно терпимый — принимает
 * несколько правдоподобных обёрток и несколько написаний полей, — а команда
 * `node deploy/seed-catalog.js --probe` печатает сырой ответ, чтобы подогнать
 * разбор по факту, а не по догадке.
 *
 * Ключ берётся в личном кабинете lis-skins и кладётся в .env:
 *
 *   LISSKINS_API_KEY=...
 */

const BASE = String(process.env.LISSKINS_API_BASE || 'https://api.lis-skins.com/v1');
const GAME = String(process.env.LISSKINS_GAME || 'rust');
const PER_PAGE = Number(process.env.LISSKINS_PER_PAGE || 500);
const MAX_PAGES = Number(process.env.LISSKINS_MAX_PAGES || 200);
const PAGE_INTERVAL_MS = Number(process.env.LISSKINS_PAGE_INTERVAL_MS || 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  return String(process.env.LISSKINS_API_KEY || '').trim();
}

function isConfigured() {
  return apiKey().length > 0;
}

/**
 * Заголовки авторизации.
 *
 * Схема не подтверждена документацией, поэтому пробуем обе распространённые:
 * сначала Bearer, при отказе — X-Api-Key. Какая сработала, видно в логе.
 */
function authHeaders(scheme) {
  const key = apiKey();
  const common = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  };
  return scheme === 'x-api-key'
    ? { ...common, 'X-Api-Key': key }
    : { ...common, 'Authorization': `Bearer ${key}` };
}

async function call(pathname, params = {}, scheme = 'bearer') {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${pathname}${qs ? '?' + qs : ''}`;
  try {
    const r = await fetch(url, {
      headers: authHeaders(scheme),
      signal: AbortSignal.timeout(60000)
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text: text.slice(0, 2000) };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: e.message };
  }
}

/**
 * Проверить ключ и заодно выяснить рабочую схему авторизации.
 * @returns {Promise<{ok: boolean, scheme?: string, message?: string}>}
 */
async function detectScheme() {
  if (!isConfigured()) return { ok: false, message: 'LISSKINS_API_KEY не задан' };

  for (const scheme of ['bearer', 'x-api-key']) {
    const r = await call('/user/balance', {}, scheme);
    if (r.ok) return { ok: true, scheme };
    // 403 с missing_api_key означает, что заголовок не распознан — пробуем другой.
    // Прочие коды (429, 500) к схеме отношения не имеют, о них сообщаем сразу.
    if (r.status !== 401 && r.status !== 403) {
      return { ok: false, message: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
    }
  }
  return { ok: false, message: 'Ключ не принят ни как Bearer, ни как X-Api-Key' };
}

/**
 * Достать массив записей из ответа, какой бы обёрткой он ни был прикрыт.
 * Возвращает null, если массива не видно — это повод посмотреть --probe.
 */
function extractRows(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  for (const key of ['data', 'items', 'result', 'results', 'skins', 'list']) {
    const v = json[key];
    if (Array.isArray(v)) return v;
    // Встречается и вложение вида { data: { items: [...] } }.
    if (v && typeof v === 'object') {
      for (const k2 of ['items', 'data', 'list']) {
        if (Array.isArray(v[k2])) return v[k2];
      }
    }
  }
  return null;
}

/** Первое непустое значение среди нескольких написаний одного поля. */
function pick(row, names) {
  for (const n of names) {
    const v = row?.[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/** Запись API -> та же форма, что даёт полная выгрузка. */
function normalize(row) {
  const classid = pick(row, ['item_class_id', 'class_id', 'classid', 'classId']);
  const name = pick(row, ['name', 'market_hash_name', 'marketHashName', 'title']);
  const price = Number(pick(row, ['price', 'unlocked_price', 'min_price', 'suggested_price']));
  return {
    classid: classid == null ? '' : String(classid),
    name: name == null ? '' : String(name).trim(),
    usd: Number.isFinite(price) && price > 0 ? price : 0
  };
}

/**
 * Весь список Rust постранично.
 *
 * @param {Function} opts.onPage ({page, got, total}) => void
 */
async function fetchCatalogList({ onPage } = {}) {
  const det = await detectScheme();
  if (!det.ok) return { ok: false, message: det.message };
  console.log(`[LisSkinsApi] Ключ принят, схема: ${det.scheme}`);

  const byClass = new Map();
  let lots = 0, page = 1, noClass = 0;

  for (; page <= MAX_PAGES; page++) {
    const r = await call('/market/search', {
      game: GAME, page, per_page: PER_PAGE
    }, det.scheme);

    if (!r.ok) {
      // Первая же страница не пришла — дальше идти незачем.
      if (page === 1) return { ok: false, message: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
      console.error(`[LisSkinsApi] Страница ${page}: HTTP ${r.status}, останавливаюсь`);
      break;
    }

    const rows = extractRows(r.json);
    if (rows === null) {
      return {
        ok: false,
        message: 'Не разобрать ответ: массива записей не видно. '
               + 'Посмотрите форму: node deploy/seed-catalog.js --probe'
      };
    }
    if (!rows.length) break;

    lots += rows.length;
    for (const raw of rows) {
      const it = normalize(raw);
      if (!it.classid) { noClass++; continue; }
      if (!it.usd) continue;
      const prev = byClass.get(it.classid);
      if (!prev || it.usd < prev.usd) byClass.set(it.classid, it);
    }

    if (typeof onPage === 'function') onPage({ page, got: rows.length, total: byClass.size });
    // Последняя страница короче полной — дальше пусто.
    if (rows.length < PER_PAGE) break;
    await sleep(PAGE_INTERVAL_MS);
  }

  if (!byClass.size) {
    return {
      ok: false,
      message: noClass
        ? `Ни у одной из ${noClass} записей нет item_class_id — без него не собрать картинки. Посмотрите --probe`
        : 'API вернул пусто'
    };
  }

  return { ok: true, items: [...byClass.values()], lots, pages: page - 1, source: 'api' };
}

/** Сырой ответ первой страницы — чтобы увидеть настоящую форму данных. */
async function probe() {
  const det = await detectScheme();
  if (!det.ok) return { ok: false, message: det.message };
  const r = await call('/market/search', { game: GAME, page: 1, per_page: 3 }, det.scheme);
  return { ok: r.ok, status: r.status, scheme: det.scheme, body: r.json ?? r.text };
}

module.exports = { isConfigured, detectScheme, fetchCatalogList, probe, extractRows, normalize, BASE };
