'use strict';

/**
 * Математика выпадения предметов из кейса.
 *
 * Заменяет прежний `items[Math.floor(Math.random() * items.length)]` — там все
 * предметы имели равный шанс, а колонки chance / ticketRangeFrom / ticketRangeTo
 * из админки не использовались вообще. Хуже того, chance отдавался игроку в
 * ответе /cases/:slug, то есть интерфейс показывал одни шансы, а сервер
 * разыгрывал другие.
 *
 * Приоритет источников веса:
 *   1. ticketRangeFrom/To — если у кейса заданы билетные диапазоны;
 *   2. chance — если сумма шансов больше нуля;
 *   3. расчёт по RTP — если в админке ничего не заполнено (сейчас это так:
 *      во всех case_items chance = 0).
 */

const crypto = require('crypto');

/** Отдача игроку по умолчанию, %. Перекрывается users.rtp и CASE_RTP. */
const DEFAULT_RTP = Number(process.env.CASE_RTP || 95);

// ---------------------------------------------------------------------------
// Подбор весов под заданную отдачу
// ---------------------------------------------------------------------------

/**
 * Веса вида  w_i ∝ price_i^(-k).
 *
 * При k = 0 распределение равномерное и средний выигрыш максимален; с ростом k
 * вес смещается к дешёвым предметам и средний выигрыш падает. Функция EV(k)
 * монотонно убывает, поэтому нужное k находится двоичным поиском — так
 * распределение получается гладким и «естественным», без ручных таблиц.
 *
 * @returns {number[]} нормированные вероятности, сумма = 1
 */
function weightsForTargetEV(prices, targetEV) {
  const n = prices.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const min = Math.min(...prices);
  const max = Math.max(...prices);

  // Цель вне досягаемости — вырождаемся в крайний случай.
  if (targetEV <= min) return prices.map(p => (p === min ? 1 / prices.filter(x => x === min).length : 0));
  if (targetEV >= max) return prices.map(p => (p === max ? 1 / prices.filter(x => x === max).length : 0));

  const evAt = (k) => {
    let sw = 0, sv = 0;
    for (const p of prices) {
      const w = Math.pow(Math.max(p, 1), -k);
      sw += w;
      sv += w * p;
    }
    return sv / sw;
  };

  let lo = 0, hi = 20;
  if (evAt(lo) < targetEV) return prices.map(() => 1 / n);   // даже равномерное даёт меньше
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (evAt(mid) > targetEV) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;

  const raw = prices.map(p => Math.pow(Math.max(p, 1), -k));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(w => w / sum);
}

/**
 * Итоговое распределение по предметам кейса.
 *
 * @param items   [{ id, name, price, chance, ticketRangeFrom, ticketRangeTo, ... }]
 * @param opts    { casePrice, rtp }
 * @returns { entries: [{ item, p }], source: 'tickets'|'chance'|'rtp', ev, rtpActual }
 */
function buildDistribution(items, { casePrice = 0, rtp = DEFAULT_RTP } = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return { entries: [], source: 'empty', ev: 0, rtpActual: 0 };

  let probs;
  let source;

  const maxTicket = Math.max(...list.map(i => Number(i.ticketRangeTo) || 0));
  const sumChance = list.reduce((a, i) => a + (Number(i.chance) || 0), 0);

  if (maxTicket > 0) {
    // Билетные диапазоны — шанс пропорционален ширине диапазона.
    const widths = list.map(i => {
      const from = Number(i.ticketRangeFrom) || 0;
      const to = Number(i.ticketRangeTo) || 0;
      return Math.max(0, to - from + (to >= from ? 1 : 0));
    });
    const total = widths.reduce((a, b) => a + b, 0);
    probs = total > 0 ? widths.map(w => w / total) : list.map(() => 1 / list.length);
    source = 'tickets';
  } else if (sumChance > 0) {
    probs = list.map(i => (Number(i.chance) || 0) / sumChance);
    source = 'chance';
  } else {
    // В админке ничего не заполнено — считаем от цены кейса и RTP.
    const targetEV = casePrice > 0 ? casePrice * (rtp / 100) : 0;
    probs = targetEV > 0
      ? weightsForTargetEV(list.map(i => Number(i.price) || 1), targetEV)
      : list.map(() => 1 / list.length);
    source = 'rtp';
  }

  const entries = list.map((item, idx) => ({ item, p: probs[idx] || 0 }));
  const ev = entries.reduce((a, e) => a + e.p * (Number(e.item.price) || 0), 0);

  return {
    entries,
    source,
    ev,
    rtpActual: casePrice > 0 ? +((ev / casePrice) * 100).toFixed(2) : 0
  };
}

// ---------------------------------------------------------------------------
// Честный бросок
// ---------------------------------------------------------------------------

/**
 * Детерминированное число [0,1) из тройки (серверный сид, клиентский сид, нонс).
 * Тот же результат воспроизводится проверкой, в отличие от Math.random().
 */
function fairFloat(serverSeed, clientSeed, nonce) {
  const hmac = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  return parseInt(hmac.slice(0, 8), 16) / 0x100000000;
}

function newServerSeed() {
  const seed = crypto.randomBytes(32).toString('hex');
  return { serverSeed: seed, serverHash: crypto.createHash('sha256').update(seed).digest('hex') };
}

/** Выбор предмета по распределению и заранее посчитанному броску. */
function pickByRoll(entries, roll) {
  let acc = 0;
  for (const e of entries) {
    acc += e.p;
    if (roll < acc) return e.item;
  }
  return entries.length ? entries[entries.length - 1].item : null;
}

/**
 * Разыгрывает одно открытие.
 * @returns { item, roll, nonce }
 */
function rollOne(distribution, { serverSeed, clientSeed, nonce }) {
  const roll = fairFloat(serverSeed, clientSeed, nonce);
  return { item: pickByRoll(distribution.entries, roll), roll, nonce };
}

/** Проценты для показа игроку — ровно те, по которым идёт розыгрыш. */
function chancesForDisplay(distribution) {
  return distribution.entries.map(e => ({
    id: e.item.id,
    chance: +(e.p * 100).toFixed(4)
  }));
}

module.exports = {
  buildDistribution,
  rollOne,
  pickByRoll,
  fairFloat,
  newServerSeed,
  chancesForDisplay,
  weightsForTargetEV,
  DEFAULT_RTP
};
