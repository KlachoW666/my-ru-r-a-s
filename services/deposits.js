'use strict';

/**
 * Заявки на пополнение.
 *
 * Было: POST /wallet/deposit/card сразу начислял деньги на баланс. Никакой
 * оплаты при этом не происходило — провайдера нет, — то есть любой вошедший
 * игрок мог выписать себе до 500 000 ₽ одним запросом и повторять сколько
 * угодно. На боевом домене это раздача денег.
 *
 * Стало: запрос создаёт ЗАЯВКУ со статусом pending и ничего не начисляет.
 * Баланс меняется ровно в одном месте — confirm(), — и только один раз:
 * повторное подтверждение той же заявки денег не добавляет.
 *
 * Схема состояний: pending -> paid | rejected | expired | failed
 *
 * Провайдер платежей подключается сюда же: его вебхук зовёт confirm() с
 * внешним идентификатором платежа. Пока провайдера нет, заявки подтверждает
 * администратор в разделе «Пополнения».
 */

const crypto = require('crypto');

/** Сколько заявка ждёт оплаты, прежде чем протухнуть. */
const TTL_MINUTES = Number(process.env.DEPOSIT_TTL_MINUTES || 60);

function makeDepositsService({ queryAdminDb, getAdminDb, adjustBalanceById }) {
  let schemaReady = false;

  const run = (sql, params = []) => new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve(null);
    db.run(sql, params, function (err) { db.close(); resolve(err ? null : this); });
  });

  async function ensureSchema() {
    if (schemaReady) return;
    await run(`CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      user_id INTEGER,
      username TEXT,
      method TEXT,
      amount REAL,
      credited REAL DEFAULT 0,
      currency TEXT DEFAULT 'RUB',
      asset TEXT,
      network TEXT,
      address TEXT,
      phone TEXT,
      promo TEXT,
      status TEXT DEFAULT 'pending',
      provider TEXT,
      provider_ref TEXT,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      settled_at TIMESTAMP,
      settled_by TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, created_at)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, created_at)`);
    schemaReady = true;
  }

  const toDto = (r) => r && ({
    id: r.uid,
    uid: r.uid,
    depositId: r.uid,
    method: r.method,
    amount: r.amount,
    credited: r.credited,
    currency: r.currency,
    asset: r.asset || undefined,
    network: r.network || undefined,
    address: r.address || undefined,
    status: r.status,
    comment: r.comment || '',
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    settledAt: r.settled_at
  });

  /**
   * Создать заявку. Денег не начисляет — это делает только confirm().
   */
  async function create({ user, method, amount, asset, network, address, phone, promo, provider }) {
    await ensureSchema();
    const uid = crypto.randomBytes(9).toString('hex');
    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();

    const r = await run(
      `INSERT INTO deposits (uid, user_id, username, method, amount, currency, asset, network,
                             address, phone, promo, status, provider, expires_at)
       VALUES (?, ?, ?, ?, ?, 'RUB', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [uid, user.id, user.username, method, amount, asset || null, network || null,
       address || null, phone || null, promo || null, provider || null, expiresAt]);
    if (!r) return null;

    return toDto(await byUid(uid));
  }

  async function byUid(uid) {
    await ensureSchema();
    const rows = await queryAdminDb(`SELECT * FROM deposits WHERE uid = ?`, [String(uid || '')]);
    return rows[0] || null;
  }

  /** Заявка вместе с проверкой, что она принадлежит этому игроку. */
  async function forUser(uid, userId) {
    const row = await byUid(uid);
    if (!row) return null;
    if (String(row.user_id) !== String(userId)) return null;
    return row;
  }

  async function listForUser(userId, limit = 50) {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT ?`, [userId, limit]);
    return rows.map(toDto);
  }

  /**
   * Подтвердить оплату и начислить деньги.
   *
   * Идемпотентна: у уже подтверждённой заявки статус не pending, и второй
   * вызов вернёт ok:false без начисления. Порядок операций такой же, как в
   * остальном проекте: сначала переводим заявку, потом трогаем баланс —
   * если начисление сорвётся, деньги не уйдут дважды.
   */
  async function confirm(uid, { by = 'admin', providerRef = null, amount = null } = {}) {
    await ensureSchema();
    const row = await byUid(uid);
    if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Заявка не найдена' };
    if (row.status !== 'pending') {
      return { ok: false, error: 'ALREADY_SETTLED', message: `Заявка уже в статусе «${row.status}»`, deposit: toDto(row) };
    }

    const credited = Number(amount != null ? amount : row.amount) || 0;
    if (credited <= 0) return { ok: false, error: 'BAD_AMOUNT', message: 'Некорректная сумма' };

    const upd = await run(
      `UPDATE deposits SET status = 'paid', credited = ?, settled_at = CURRENT_TIMESTAMP,
                           settled_by = ?, provider_ref = COALESCE(?, provider_ref)
       WHERE uid = ? AND status = 'pending'`,
      [credited, by, providerRef, uid]);
    // changes = 0 означает, что кто-то подтвердил заявку параллельно.
    if (!upd || !upd.changes) {
      return { ok: false, error: 'ALREADY_SETTLED', message: 'Заявка уже обработана' };
    }

    await adjustBalanceById(row.user_id, credited, 'deposit',
      `Пополнение ${row.method}${row.asset ? ' ' + row.asset : ''} №${row.uid}`);

    return { ok: true, credited, deposit: toDto(await byUid(uid)) };
  }

  async function reject(uid, { by = 'admin', comment = '' } = {}) {
    await ensureSchema();
    const row = await byUid(uid);
    if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Заявка не найдена' };
    if (row.status !== 'pending') {
      return { ok: false, error: 'ALREADY_SETTLED', message: `Заявка уже в статусе «${row.status}»` };
    }
    await run(
      `UPDATE deposits SET status = 'rejected', settled_at = CURRENT_TIMESTAMP, settled_by = ?, comment = ?
       WHERE uid = ? AND status = 'pending'`,
      [by, comment || 'Отклонено', uid]);
    return { ok: true, deposit: toDto(await byUid(uid)) };
  }

  /**
   * Протухшие заявки. Просто помечаем — денег они не касались, поэтому
   * возвращать нечего.
   */
  async function expireStale() {
    await ensureSchema();
    const r = await run(
      `UPDATE deposits SET status = 'expired'
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
      [new Date().toISOString()]);
    return r ? r.changes : 0;
  }

  /** Привязать заявку к платежу шлюза — по нему потом придёт вебхук. */
  async function attachProvider(uid, provider, providerRef) {
    await run(`UPDATE deposits SET provider = ?, provider_ref = ? WHERE uid = ?`,
      [provider, providerRef || null, uid]);
    return toDto(await byUid(uid));
  }

  /**
   * Шлюз не принял платёж. Заявку не удаляем: пусть останется в админке
   * следом неудачи, иначе такие случаи расследовать будет нечем.
   */
  async function markFailed(uid, comment) {
    await run(
      `UPDATE deposits SET status = 'failed', comment = ?, settled_at = CURRENT_TIMESTAMP, settled_by = 'gateway'
        WHERE uid = ? AND status = 'pending'`,
      [String(comment || 'Шлюз недоступен').slice(0, 300), uid]);
    return toDto(await byUid(uid));
  }

  return { ensureSchema, create, byUid, forUser, listForUser, confirm, reject,
           attachProvider, markFailed, expireStale, toDto, TTL_MINUTES };
}

module.exports = { makeDepositsService };
