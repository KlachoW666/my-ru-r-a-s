'use strict';

/**
 * Платёжный шлюз RollyPay (docs.rollypay.io).
 *
 * Что делает: создаёт платёж и отдаёт `pay_url`, куда уходит игрок, а факт
 * оплаты приносит вебхуком. Деньги на баланс начисляет НЕ этот модуль —
 * он только подтверждает подпись и говорит «оплачено». Начисление живёт
 * в services/deposits.js, в одном месте на всю систему.
 *
 * Аутентификация запросов:
 *   X-API-Key: rpk_live_…
 *   X-Nonce:   уникальный UUID, нельзя повторять в течение 10 минут
 * terminal_id можно не передавать — ключ уже привязан к кассе.
 *
 * Подпись вебхука: HMAC-SHA256 от строки `timestamp + "." + сырое тело`
 * ключом signing_secret, заголовки X-Signature и X-Timestamp.
 * Подписывается именно СЫРОЕ тело, поэтому JSON.stringify(req.body) здесь
 * не подходит: порядок ключей и пробелы после разбора уже не те.
 */

const crypto = require('crypto');

const API_URL = String(process.env.ROLLYPAY_API_URL || 'https://api.rollypay.io').replace(/\/+$/, '');
const API_KEY = process.env.ROLLYPAY_API_KEY || '';
const SIGNING_SECRET = process.env.ROLLYPAY_SIGNING_SECRET || '';
const TERMINAL_ID = process.env.ROLLYPAY_TERMINAL_ID || '';
const TEST_MODE = process.env.ROLLYPAY_TEST === '1';

/** Насколько старым может быть вебхук. Защита от повторной отправки записи. */
const MAX_SKEW_SECONDS = Number(process.env.ROLLYPAY_MAX_SKEW || 300);

/** Настроен ли шлюз. Без ключей работаем в ручном режиме, как раньше. */
function isConfigured() {
  return Boolean(API_KEY && SIGNING_SECRET);
}

/**
 * Наш способ оплаты -> способ RollyPay.
 * В API есть sbp, card, intl_card, crypto. Crypto Bot и xRocket отдельными
 * идентификаторами не описаны — они выбираются уже на форме оплаты внутри
 * crypto, поэтому мы их не навязываем.
 */
function mapMethod(method) {
  const m = String(method || '').toLowerCase();
  if (['sbp', 'сбп'].includes(m)) return 'sbp';
  if (['card', 'fiat', 'карта'].includes(m)) return 'card';
  if (['intl_card', 'intl'].includes(m)) return 'intl_card';
  if (['crypto', 'usdt', 'eth', 'ltc', 'trx', 'cryptobot', 'xrocket'].includes(m)) return 'crypto';
  return null;   // не указали — игрок выберет на форме RollyPay
}

async function apiCall(path, { method = 'POST', body = null } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'NOT_CONFIGURED', message: 'RollyPay не настроен' };
  }
  const url = `${API_URL}${path}`;
  const headers = {
    'X-API-Key': API_KEY,
    // Nonce обязан быть уникальным: повтор в течение 10 минут даёт 401.
    'X-Nonce': crypto.randomUUID(),
    'Accept': 'application/json'
  };
  if (body) headers['Content-Type'] = 'application/json';

  try {
    const r = await fetch(url, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!r.ok) {
      console.error(`[RollyPay] ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: r.status, error: 'API_ERROR', message: data?.message || `HTTP ${r.status}`, data };
    }
    return { ok: true, data };
  } catch (e) {
    console.error(`[RollyPay] ${method} ${path}: ${e.message}`);
    return { ok: false, error: 'NETWORK', message: e.message };
  }
}

/**
 * Создать платёж.
 * @param {string} orderId  наш uid заявки — по нему вебхук найдёт заявку обратно
 */
async function createPayment({ orderId, amount, method, description, customerId, successUrl, failUrl, metadata }) {
  const payload = {
    // amount строкой: в документации это строка вида "1500.00".
    amount: Number(amount).toFixed(2),
    payment_currency: 'RUB',
    order_id: String(orderId),
    description: description || `Пополнение баланса, заявка ${orderId}`,
    success_redirect_url: successUrl,
    fail_redirect_url: failUrl
  };

  const mapped = mapMethod(method);
  if (mapped) payload.payment_method = mapped;
  if (TERMINAL_ID) payload.terminal_id = TERMINAL_ID;
  if (customerId) payload.customer_id = String(customerId);
  if (metadata) payload.metadata = metadata;
  if (TEST_MODE) payload.test = true;

  const r = await apiCall('/api/v1/payments', { body: payload });
  if (!r.ok) return r;

  const d = r.data || {};
  if (!d.pay_url) {
    console.error('[RollyPay] в ответе нет pay_url:', JSON.stringify(d).slice(0, 300));
    return { ok: false, error: 'NO_PAY_URL', message: 'Шлюз не вернул ссылку на оплату' };
  }
  return {
    ok: true,
    paymentId: d.payment_id,
    payUrl: d.pay_url,
    status: d.status || 'created',
    expiresAt: d.expires_at || null
  };
}

/** Статус платежа — на случай, если вебхук не дошёл. */
async function getPayment(paymentId) {
  return apiCall(`/api/v1/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
}

/**
 * Проверка подписи вебхука.
 *
 * @param {Buffer|string} rawBody сырое тело запроса, до разбора JSON
 * @returns {{ok:boolean, reason?:string}}
 */
function verifyWebhook({ rawBody, signature, timestamp }) {
  if (!SIGNING_SECRET) return { ok: false, reason: 'ROLLYPAY_SIGNING_SECRET не задан' };
  if (!signature || !timestamp) return { ok: false, reason: 'нет заголовка X-Signature или X-Timestamp' };

  // Старый вебхук не принимаем: иначе однажды подсмотренный запрос можно
  // было бы отправить повторно и получить второе «оплачено».
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'X-Timestamp не число' };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > MAX_SKEW_SECONDS) return { ok: false, reason: `отметка времени разошлась на ${skew} с` };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto.createHmac('sha256', SIGNING_SECRET)
    .update(String(timestamp) + '.' + body)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // timingSafeEqual падает на разной длине — сравниваем длину заранее.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'подпись не сошлась' };
  }
  return { ok: true };
}

module.exports = {
  isConfigured, createPayment, getPayment, verifyWebhook, mapMethod,
  API_URL, TEST_MODE
};
