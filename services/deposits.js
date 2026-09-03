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
const { transaction } = require('./sqliteTransaction');

/** Сколько заявка ждёт оплаты, прежде чем протухнуть. */
const TTL_MINUTES = Number(process.env.DEPOSIT_TTL_MINUTES || 60);

function makeDepositsService({ queryAdminDb, getAdminDb }) {
  let schemaReady = false;

  const run = (sql, params = []) => new Promise((resolve, reject) => {
    const db = getAdminDb();
    if (!db) return reject(new Error('Database unavailable'));
    db.run(sql, params, function (err) { const result=this; db.close(()=>err?reject(err):resolve(result)); });
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
    await run('CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, amount REAL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    await run(`CREATE TABLE IF NOT EXISTS wallet_manual_requests (
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, deposit_uid TEXT NOT NULL UNIQUE)`);
    await run(`CREATE TABLE IF NOT EXISTS wallet_wagers (
      user_id INTEGER PRIMARY KEY, required_cents INTEGER NOT NULL DEFAULT 0,
      remaining_cents INTEGER NOT NULL DEFAULT 0)`);
    await run(`CREATE TRIGGER IF NOT EXISTS wallet_wager_bet AFTER INSERT ON transactions
      WHEN NEW.type IN ('case_open','upgrade','battle_entry') AND NEW.amount < 0 BEGIN
        UPDATE wallet_wagers SET remaining_cents = MAX(0, remaining_cents - CAST(ROUND(-NEW.amount*100) AS INTEGER))
        WHERE user_id = NEW.user_id;
      END`);
    await run(`CREATE TRIGGER IF NOT EXISTS wallet_wager_refund AFTER INSERT ON transactions
      WHEN NEW.type IN ('battle_refund','case_refund','upgrade_refund') AND NEW.amount > 0 BEGIN
        UPDATE wallet_wagers SET remaining_cents = MIN(required_cents, remaining_cents + CAST(ROUND(NEW.amount*100) AS INTEGER))
        WHERE user_id = NEW.user_id;
      END`);
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
   * вызов вернёт ok:false без начисления. Баланс, журнал и статус заявки
   * фиксируются одной SQLite-транзакцией; ошибка откатывает всё.
   */
  async function confirm(uid, { by = 'admin', providerRef = null, amount = null, manual = null } = {}) {
    await ensureSchema();
    return transaction(getAdminDb, async ({get,run}) => {
    if (manual) {
      const previous = await get('SELECT * FROM wallet_manual_requests WHERE request_id = ?', [manual.requestId]);
      if (previous) {
        if (previous.fingerprint !== manual.fingerprint)
          return {ok:false,error:'IDEMPOTENCY_CONFLICT',message:'Этот запрос уже использован с другими параметрами'};
        const deposit = await get('SELECT * FROM deposits WHERE uid = ?', [previous.deposit_uid]);
        if (deposit?.status === 'paid') return {ok:true,replayed:true,credited:deposit.credited,deposit:toDto(deposit)};
        return {ok:false,error:'ALREADY_SETTLED',message:'Запрос уже обработан'};
      }
      const owner = await get('SELECT id,username FROM users WHERE id = ?', [manual.userId]);
      if (!owner) return {ok:false,error:'USER_NOT_FOUND',message:'Пользователь не найден'};
      await run(`INSERT INTO deposits(uid,user_id,username,method,amount,status,provider,comment)
        VALUES (?,?,?,'manual',?,'pending','admin',?)`, [uid,owner.id,owner.username,manual.amount,manual.reason]);
      await run('INSERT INTO wallet_manual_requests(request_id,fingerprint,deposit_uid) VALUES(?,?,?)',
        [manual.requestId,manual.fingerprint,uid]);
    }
    const row = await get('SELECT * FROM deposits WHERE uid = ?', [uid]);
    if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Заявка не найдена' };
    if (row.status !== 'pending') {
      return { ok: false, error: 'ALREADY_SETTLED', message: `Заявка уже в статусе «${row.status}»`, deposit: toDto(row) };
    }

    const credited = Number(amount != null ? amount : row.amount);
    const cents = Math.round(credited * 100);
    if (!Number.isSafeInteger(cents) || credited <= 0 || Math.abs(credited*100-cents)>1e-6)
      return { ok: false, error: 'BAD_AMOUNT', message: 'Некорректная сумма' };
    const user = await get('SELECT id,balance FROM users WHERE id = ?', [row.user_id]);
    if (!user) return { ok:false,error:'USER_NOT_FOUND',message:'Пользователь не найден' };
    if (!Number.isSafeInteger(Math.round(Number(user.balance)*100)+cents))
      return {ok:false,error:'BAD_AMOUNT',message:'Превышен допустимый баланс'};

    const upd = await run(
      `UPDATE deposits SET status = 'paid', credited = ?, settled_at = CURRENT_TIMESTAMP,
                           settled_by = ?, provider_ref = COALESCE(?, provider_ref)
       WHERE uid = ? AND status = 'pending'`,
      [credited, by, providerRef, uid]);
    // changes = 0 означает, что кто-то подтвердил заявку параллельно.
    if (!upd || !upd.changes) {
      return { ok: false, error: 'ALREADY_SETTLED', message: 'Заявка уже обработана' };
    }

    await run('CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, amount REAL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    await run('UPDATE users SET balance = ROUND(COALESCE(balance,0) + ?,2) WHERE id = ?', [credited,row.user_id]);
    await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES (?,'deposit',?,?)", [row.user_id,credited,
      `Пополнение ${row.method}${row.asset ? ' ' + row.asset : ''} №${row.uid}${row.comment ? ': '+row.comment : ''}`]);
    if (manual?.wagerCents) {
      const current = await get('SELECT remaining_cents FROM wallet_wagers WHERE user_id = ?', [row.user_id]);
      const required = Number(current?.remaining_cents || 0) + manual.wagerCents;
      if (!Number.isSafeInteger(required)) throw new Error('Wager amount overflow');
      await run(`INSERT INTO wallet_wagers(user_id,required_cents,remaining_cents) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET required_cents=excluded.required_cents,remaining_cents=excluded.remaining_cents`,
        [row.user_id,required,required]);
    }

    return { ok: true, credited, deposit: toDto(await get('SELECT * FROM deposits WHERE uid = ?', [uid])) };
    });
  }

  async function manualCredit({userId,amount,reason,wagerMultiplier='0',requestId,by='admin'}) {
    const value = Number(amount), multiplier = Number(wagerMultiplier);
    const wagerCents = Math.round(value * 100 * multiplier);
    if (!/^\d+(\.\d{1,2})?$/.test(String(amount)) || !Number.isFinite(value) || value<=0 || value>10000000)
      return {ok:false,error:'BAD_AMOUNT',message:'Сумма должна быть от 0.01 до 10000000 ₽'};
    if (!/^\d+(\.\d{1,8})?$/.test(String(wagerMultiplier)) || !Number.isFinite(multiplier) || multiplier<0 || !Number.isSafeInteger(wagerCents))
      return {ok:false,error:'BAD_WAGER',message:'Некорректный множитель отыгрыша'};
    if (typeof reason!=='string' || !reason.trim() || reason.length>500)
      return {ok:false,error:'BAD_REASON',message:'Укажите причину длиной до 500 символов'};
    if (typeof requestId!=='string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))
      return {ok:false,error:'BAD_REQUEST_ID',message:'Обновите страницу: отсутствует идентификатор операции'};
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify([String(userId),value,reason.trim(),multiplier,String(by)])).digest('hex');
    return confirm('manual-'+crypto.createHash('sha256').update(requestId).digest('hex'),{by,
      manual:{userId,amount:value,reason:reason.trim(),requestId,fingerprint,wagerCents}});
  }

  async function wager(userId) {
    await ensureSchema();
    const rows = await queryAdminDb('SELECT remaining_cents FROM wallet_wagers WHERE user_id = ?', [userId]);
    if (rows.failed) throw new Error('Cannot read wager');
    const cents = Number(rows[0]?.remaining_cents || 0);
    return {remaining:(cents/100).toFixed(2),hasActiveWager:cents>0};
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

  return { ensureSchema, create, byUid, forUser, listForUser, confirm, reject, manualCredit, wager,
           attachProvider, markFailed, expireStale, toDto, TTL_MINUTES };
}

module.exports = { makeDepositsService };
