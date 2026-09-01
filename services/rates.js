'use strict';

/**
 * Курсы валют для кошелька.
 *
 * Было: таблица wallet_rates заполнялась один раз при создании и больше не
 * менялась — на боевом сервере значения стояли с 23 августа. Строки USDT в ней
 * не было вовсе, хотя пополнение в крипте показывает сумму именно в USDT.
 * Курс USD→RUB при этом обновлялся, но жил в памяти процесса каталога и в
 * кошелёк не попадал.
 *
 * Стало: курсы обновляются сами и складываются в ту же таблицу, откуда их
 * читает и кошелёк, и админка.
 *
 * Откуда что берётся:
 *
 *   USDT  — из RollyPay, GET /api/v1/rate. Это курс, по которому шлюз реально
 *           конвертирует рубли, поэтому он важнее любого биржевого: игрок
 *           платит по нему. Если шлюз не настроен или молчит — берём USD,
 *           USDT привязан к доллару.
 *   USD, EUR — exchangerate-api, тот же источник, что у каталога предметов.
 *   ETH, LTC, BTC — coingecko. Не критично: не ответил, останется прежнее.
 *
 * Строки с source = 'manual' не трогаются никогда. KZT и BYN администратор
 * выставляет руками, и затирать их автообновлением нельзя.
 */

const RATES_TTL_MS = Number(process.env.RATES_REFRESH_MS || 30 * 60 * 1000);

/** Границы вменяемости. Кривой ответ не должен обвалить экономику. */
const SANE = {
  USD: [10, 1000],
  EUR: [10, 1000],
  USDT: [10, 1000],
  ETH: [10000, 100000000],
  LTC: [100, 10000000],
  BTC: [100000, 1000000000]
};

function isSane(code, value) {
  const b = SANE[code];
  if (!b) return Number.isFinite(value) && value > 0;
  return Number.isFinite(value) && value >= b[0] && value <= b[1];
}

async function getJson(url, timeoutMs = 8000, headers = {}) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function makeRatesService({ queryAdminDb, getAdminDb, rollypay }) {
  let lastRun = 0;

  /**
   * Запись в базу.
   *
   * Ошибку НЕ проглатываем: сначала так и было, и обновление курсов молча не
   * происходило, а в лог при этом писалось «Обновлено» — счётчик считал
   * попытки, а не успехи. Сообщение врало, и найти это можно было только
   * сверив таблицу руками.
   *
   * busyTimeout обязателен: базу одновременно держат игровой сервер, обход
   * каталога и админка, и без ожидания запись падает с SQLITE_BUSY.
   */
  const run = (sql, params = []) => new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve({ ok: false, error: 'база недоступна' });
    db.configure('busyTimeout', 5000);
    db.run(sql, params, function (err) {
      db.close();
      resolve(err ? { ok: false, error: err.message } : { ok: true, changes: this.changes });
    });
  });

  async function ensureSchema() {
    await run(`CREATE TABLE IF NOT EXISTS wallet_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT UNIQUE,
      rate REAL,
      source TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  }

  /** Курс USDT прямо от шлюза: по нему считает он сам. */
  async function usdtFromGateway() {
    if (!rollypay || !rollypay.isConfigured()) return null;
    const r = await getJson(`${rollypay.API_URL}/api/v1/rate`, 8000, {
      'X-API-Key': process.env.ROLLYPAY_API_KEY || '',
      'X-Nonce': require('crypto').randomUUID()
    });
    const rate = Number(r?.rate);
    return isSane('USDT', rate) ? rate : null;
  }

  /**
   * Обновить курсы.
   * @param {boolean} force игнорировать интервал
   */
  async function refresh({ force = false } = {}) {
    if (!force && Date.now() - lastRun < RATES_TTL_MS) return { skipped: true };
    lastRun = Date.now();
    await ensureSchema();

    // Что уже лежит: нужно знать, какие строки выставлены вручную.
    const existing = await queryAdminDb(`SELECT currency, rate, source FROM wallet_rates`);
    const manual = new Set(existing
      .filter(r => String(r.source || '').toLowerCase() === 'manual')
      .map(r => String(r.currency).toUpperCase()));

    const next = {};

    // --- фиат ---
    const fx = await getJson('https://api.exchangerate-api.com/v4/latest/USD');
    if (fx?.rates?.RUB && isSane('USD', Number(fx.rates.RUB))) {
      next.USD = { rate: Number(fx.rates.RUB), source: 'auto' };
      if (fx.rates.EUR) {
        const eurRub = Number(fx.rates.RUB) / Number(fx.rates.EUR);
        if (isSane('EUR', eurRub)) next.EUR = { rate: Math.round(eurRub * 100) / 100, source: 'auto' };
      }
    }

    // --- USDT: сначала шлюз, потом доллар ---
    const gw = await usdtFromGateway();
    if (gw) {
      next.USDT = { rate: gw, source: 'rollypay' };
    } else if (next.USD) {
      // USDT — стейблкоин, привязан к доллару. Пока шлюз молчит, это ближе
      // всего к правде, и уж точно лучше значения полугодовой давности.
      next.USDT = { rate: next.USD.rate, source: 'auto (по USD)' };
    }

    // --- прочая крипта: не критично ---
    const cg = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,litecoin,bitcoin&vs_currencies=rub');
    const cgMap = { ETH: cg?.ethereum?.rub, LTC: cg?.litecoin?.rub, BTC: cg?.bitcoin?.rub };
    for (const [code, value] of Object.entries(cgMap)) {
      const v = Number(value);
      if (isSane(code, v)) next[code] = { rate: Math.round(v * 100) / 100, source: 'auto' };
    }

    // Рубль — база, всегда единица.
    next.RUB = { rate: 1, source: 'base' };

    const written = [];
    const failed = [];
    for (const [code, { rate, source }] of Object.entries(next)) {
      if (manual.has(code)) continue;             // руками выставленное не трогаем
      const r = await run(
        `INSERT INTO wallet_rates (currency, rate, source, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(currency) DO UPDATE SET
           rate = excluded.rate, source = excluded.source, updated_at = CURRENT_TIMESTAMP`,
        [code, rate, source]);
      // Считаем только то, что действительно записалось.
      if (r.ok) written.push(`${code}=${rate}`);
      else failed.push(`${code}: ${r.error}`);
    }

    return {
      ok: failed.length === 0,
      written,
      failed,
      skippedManual: [...manual],
      usdtSource: next.USDT?.source || 'нет'
    };
  }

  return { refresh, ensureSchema, isSane, RATES_TTL_MS };
}

module.exports = { makeRatesService };
