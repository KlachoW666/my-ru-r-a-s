'use strict';

/**
 * Колесо бонусов: бесплатный прокрут раз в 24 часа плюс попытка за каждую
 * 1000 ₽ пополнений.
 *
 * ПОЧЕМУ ПОПЫТКИ — ЖУРНАЛ, А НЕ СЧЁТЧИК
 *
 * Колонка spins_left рассыпается при первой же гонке (два запроса читают 3,
 * оба пишут 2) и её невозможно проверить постфактум: откуда взялась попытка и
 * куда делась — неизвестно. Здесь каждая попытка это строка: видно, за что
 * выдана и каким прокрутом потрачена. Тот же довод, по которому деньги
 * апгрейдера считаются одним UPDATE с условием, а не чтением и записью.
 *
 * КАК НАЧИСЛЯЮТСЯ ПОПЫТКИ
 *
 * Лениво, при обращении к состоянию или прокруту, и всегда идемпотентно:
 *
 *   daily     одна строка на календарные сутки по UTC (уникальный ключ)
 *   deposit   floor(всего_пополнено / 1000) минус уже выданные
 *
 * За депозит считается НАКОПЛЕННАЯ сумма, а не каждое пополнение отдельно:
 * иначе десять пополнений по 100 ₽ не дадут ничего, и игрок будет прав, считая
 * это обманом.
 *
 * ЧЕСТНОСТЬ
 *
 * Бросок берётся у services/fairness через nextRoll(userId, 'wheel'): хэш
 * серверного сида опубликован заранее, сам сид раскрывается при смене пары.
 * Своей криптографии здесь нет намеренно.
 */

const { transaction } = require('./sqliteTransaction');

/** Порог пополнений за одну дополнительную попытку, ₽. */
const DEPOSIT_STEP = Number(process.env.WHEEL_DEPOSIT_STEP || 1000);

/** Сколько попыток можно накопить. Иначе кит копит сотню и откручивает залпом. */
const MAX_BANKED = Number(process.env.WHEEL_MAX_BANKED || 10);

/** Сколько дней живёт выигранная скидка. */
const DISCOUNT_DAYS = Number(process.env.WHEEL_DISCOUNT_DAYS || 7);

/**
 * Сектора по умолчанию. Веса в сотых долях процента, сумма ровно 10000 —
 * так распределение проверяется сложением, без плавающей точки.
 *
 * kind:
 *   balance    начислить на баланс
 *   discount   скидка percent% на один кейс дешевле maxCasePrice
 *   spin       ещё одна попытка
 */
// Палитра держится тёмно-оранжевой гаммы сайта: частые призы — приглушённый
// фон со светлым текстом, редкие — яркий акцент с тёмным. Так дорогой сектор
// видно сразу, а колесо не выглядит радугой на тёмной странице.
const DEFAULT_SECTORS = [
  { code: 'b10',  label: '10 ₽',    kind: 'balance',  amount: 10,   weight: 450, copies: 6, color: '#2a1d16', ink: '#e8dcd2' },
  { code: 'b25',  label: '25 ₽',    kind: 'balance',  amount: 25,   weight: 420, copies: 5, color: '#3b2921', ink: '#f0e4d8' },
  { code: 'd15',  label: '−15%',    kind: 'discount', percent: 15,  maxCasePrice: 299, weight: 450, copies: 4, color: '#2f5d46', ink: '#e6fff2' },
  { code: 'd25',  label: '−25%',    kind: 'discount', percent: 25,  maxCasePrice: 599, weight: 400, copies: 3, color: '#4a3566', ink: '#f2e8ff' },
  { code: 'spin', label: '+1 крут', kind: 'spin',                    weight: 400, copies: 2, color: '#8a4a18', ink: '#fff1e2' },
  { code: 'b100', label: '100 ₽',   kind: 'balance',  amount: 100,  weight: 350, copies: 2, color: '#27506f', ink: '#e6f4ff' },
  { code: 'd35',  label: '−35%',    kind: 'discount', percent: 35,  maxCasePrice: 599, weight: 500, copies: 1, color: '#f36a21', ink: '#150d08' },
  { code: 'jack', label: '1000 ₽',  kind: 'balance',  amount: 1000, weight: 200, copies: 1, color: '#f2c94c', ink: '#150d08' }
];

/** Разворачивает описание в 24 сектора колеса — по copies штук на приз. */
function sectorRing(defs = DEFAULT_SECTORS) {
  const ring = [];
  for (const d of defs) for (let i = 0; i < d.copies; i++) ring.push({ ...d, index: ring.length });
  return ring;
}

const cents = v => {
  const n = Number(v), c = Math.round(n * 100);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(c)) {
    throw Object.assign(new Error('Некорректная сумма'), { status: 400 });
  }
  return c;
};

const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code });
};

/** Сутки по UTC — ключ бесплатного прокрута. */
const dayKey = (at = new Date()) => at.toISOString().slice(0, 10);

function makeWheelService({ getAdminDb, queryAdminDb, fairness }) {
  let ready;
  function ensureSchema() {
    if (!ready) ready = transaction(getAdminDb, async ({ run }) => {
      // granted_key делает начисление идемпотентным: 'daily:2026-09-07',
      // 'deposit:3'. Повторный вызов не создаёт вторую попытку.
      await run(`CREATE TABLE IF NOT EXISTS wheel_spins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        granted_key TEXT NOT NULL,
        granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        consumed_at TEXT,
        round_id INTEGER)`);
      await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wheel_spin_key
        ON wheel_spins(user_id, granted_key)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_wheel_spin_free
        ON wheel_spins(user_id, consumed_at)`);
      await run(`CREATE TABLE IF NOT EXISTS wheel_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        sector_index INTEGER NOT NULL,
        sector_code TEXT NOT NULL,
        prize_json TEXT NOT NULL,
        roll REAL NOT NULL,
        nonce INTEGER,
        server_hash TEXT,
        client_seed TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wheel_round_request
        ON wheel_rounds(user_id, request_id)`);
      // Скидка на кейс. used_at ставится ТОЛЬКО вместе со списанием за кейс,
      // одной транзакцией — иначе сбой открытия сжигал бы скидку.
      await run(`CREATE TABLE IF NOT EXISTS case_discounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        percent INTEGER NOT NULL,
        max_case_price REAL NOT NULL,
        source TEXT NOT NULL,
        granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT,
        used_at TEXT,
        used_case_slug TEXT)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_case_discount_live
        ON case_discounts(user_id, used_at)`);
      await run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT,
        amount REAL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    }).catch(error => { ready = undefined; throw error; });
    return ready;
  }

  /**
   * Досыпает недостающие попытки. Идемпотентно: конфликт по granted_key
   * означает, что попытка уже выдана, и это не ошибка.
   *
   * Выполняется внутри переданной транзакции, чтобы прокрут видел начисление.
   */
  async function grantDue(tx, userId) {
    const today = dayKey();
    await tx.run(
      `INSERT OR IGNORE INTO wheel_spins (user_id, kind, granted_key) VALUES (?, 'daily', ?)`,
      [userId, `daily:${today}`]);

    const dep = await tx.get(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? AND type = 'deposit'`,
      [userId]);
    const earned = Math.floor((Number(dep?.total) || 0) / DEPOSIT_STEP);
    const had = await tx.get(
      `SELECT COUNT(*) AS n FROM wheel_spins WHERE user_id = ? AND kind = 'deposit'`, [userId]);
    for (let i = Number(had?.n) || 0; i < earned; i++) {
      await tx.run(
        `INSERT OR IGNORE INTO wheel_spins (user_id, kind, granted_key) VALUES (?, 'deposit', ?)`,
        [userId, `deposit:${i + 1}`]);
    }
  }

  async function available(tx, userId) {
    const row = await tx.get(
      `SELECT COUNT(*) AS n FROM wheel_spins WHERE user_id = ? AND consumed_at IS NULL`, [userId]);
    return Number(row?.n) || 0;
  }

  /** Состояние для интерфейса: сколько попыток, когда следующая бесплатная. */
  async function state(userId) {
    await ensureSchema();
    if (!userId) {
      return { spins: 0, sectors: sectorRing(), nextDailyAt: null,
        depositStep: DEPOSIT_STEP, maxBanked: MAX_BANKED, guest: true };
    }
    return transaction(getAdminDb, async tx => {
      await grantDue(tx, userId);
      const spins = Math.min(await available(tx, userId), MAX_BANKED);
      const next = new Date(); next.setUTCHours(24, 0, 0, 0);
      const claimedToday = await tx.get(
        `SELECT 1 AS x FROM wheel_spins WHERE user_id = ? AND granted_key = ? AND consumed_at IS NOT NULL`,
        [userId, `daily:${dayKey()}`]);
      const dep = await tx.get(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE user_id = ? AND type = 'deposit'`,
        [userId]);
      const total = Number(dep?.total) || 0;
      return {
        spins,
        sectors: sectorRing(),
        nextDailyAt: claimedToday ? next.toISOString() : null,
        depositStep: DEPOSIT_STEP,
        maxBanked: MAX_BANKED,
        depositTotal: total,
        toNextDepositSpin: DEPOSIT_STEP - (total % DEPOSIT_STEP)
      };
    });
  }

  /** Выбор сектора по броску 0..1 и весам. */
  function pick(ring, roll) {
    const total = ring.reduce((s, x) => s + x.weight, 0);
    let acc = 0;
    const target = Math.min(0.9999999, Math.max(0, roll)) * total;
    for (const s of ring) { acc += s.weight; if (target < acc) return s; }
    return ring[ring.length - 1];
  }

  /** Выдача приза внутри транзакции прокрута. */
  async function payout(tx, userId, sector) {
    if (sector.kind === 'balance') {
      const amount = cents(sector.amount);
      const upd = await tx.run(
        'UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?', [amount / 100, userId]);
      if (upd.changes !== 1) fail(503, 'PAYOUT_FAILED', 'Не удалось начислить приз');
      await tx.run(
        `INSERT INTO transactions (user_id, type, amount, comment) VALUES (?, 'wheel_win', ?, ?)`,
        [userId, amount / 100, `Колесо: ${sector.label}`]);
      return { kind: 'balance', amount: amount / 100, label: sector.label };
    }
    if (sector.kind === 'discount') {
      const expires = new Date(Date.now() + DISCOUNT_DAYS * 86400000).toISOString();
      const r = await tx.run(
        `INSERT INTO case_discounts (user_id, percent, max_case_price, source, expires_at)
         VALUES (?, ?, ?, 'wheel', ?)`,
        [userId, sector.percent, sector.maxCasePrice, expires]);
      return { kind: 'discount', percent: sector.percent, maxCasePrice: sector.maxCasePrice,
        expiresAt: expires, id: r.lastID, label: sector.label };
    }
    if (sector.kind === 'spin') {
      // Ключ с меткой времени: подаренные прокруты не конфликтуют между собой.
      await tx.run(
        `INSERT OR IGNORE INTO wheel_spins (user_id, kind, granted_key) VALUES (?, 'bonus', ?)`,
        [userId, `bonus:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`]);
      return { kind: 'spin', label: sector.label };
    }
    fail(500, 'UNKNOWN_PRIZE', 'Неизвестный тип приза');
  }

  /**
   * Один прокрут.
   *
   * requestId обязателен и делает прокрут идемпотентным: двойной клик или
   * повтор запроса вернут тот же приз, а не сожгут вторую попытку.
   */
  async function spin(userId, requestId) {
    if (!userId) fail(401, 'UNAUTHORIZED', 'Нужно войти в аккаунт');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
      fail(400, 'REQUEST_ID_REQUIRED', 'Нужен requestId (8–100 символов)');
    }
    await ensureSchema();

    // Бросок берётся ДО транзакции: fairness пишет своим подключением, и
    // вложение чужой записи в BEGIN IMMEDIATE здесь заблокировало бы базу.
    const previous = await queryAdminDb(
      'SELECT prize_json FROM wheel_rounds WHERE user_id = ? AND request_id = ?', [userId, requestId]);
    if (previous.length) return { ...JSON.parse(previous[0].prize_json), replayed: true };

    const ring = sectorRing();
    const fair = await fairness.nextRoll(userId, 'wheel', 1);
    const roll = fair.rolls[0].roll;
    const sector = pick(ring, roll);

    return transaction(getAdminDb, async tx => {
      const again = await tx.get(
        'SELECT prize_json FROM wheel_rounds WHERE user_id = ? AND request_id = ?', [userId, requestId]);
      if (again) return { ...JSON.parse(again.prize_json), replayed: true };

      await grantDue(tx, userId);

      // Тратим КОНКРЕТНУЮ свободную попытку условным UPDATE: если её уже
      // забрал параллельный запрос, changes будет 0 и прокрут не состоится.
      const free = await tx.get(
        `SELECT id FROM wheel_spins WHERE user_id = ? AND consumed_at IS NULL ORDER BY id LIMIT 1`,
        [userId]);
      if (!free) fail(409, 'NO_SPINS', 'Попыток нет. Возвращайтесь завтра или пополните счёт.');
      const taken = await tx.run(
        `UPDATE wheel_spins SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL`,
        [free.id]);
      if (taken.changes !== 1) fail(409, 'NO_SPINS', 'Попытка уже потрачена. Обновите страницу.');

      const prize = await payout(tx, userId, sector);
      const result = {
        sectorIndex: sector.index, sectorCode: sector.code, prize,
        fair: { roll, nonce: fair.rolls[0].nonce, serverHash: fair.serverHash, clientSeed: fair.clientSeed }
      };
      const round = await tx.run(
        `INSERT INTO wheel_rounds (user_id, request_id, sector_index, sector_code, prize_json,
                                   roll, nonce, server_hash, client_seed)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [userId, requestId, sector.index, sector.code, JSON.stringify(result),
         roll, fair.rolls[0].nonce, fair.serverHash, fair.clientSeed]);
      await tx.run('UPDATE wheel_spins SET round_id = ? WHERE id = ?', [round.lastID, free.id]);

      const balanceRow = await tx.get('SELECT balance FROM users WHERE id = ?', [userId]);
      return { ...result, spinsLeft: await available(tx, userId), balance: Number(balanceRow?.balance) || 0 };
    });
  }

  /**
   * Лучшая применимая скидка для кейса. Возвращает строку или null.
   * Берём самую выгодную, а не самую старую: игрок ждёт именно этого.
   */
  async function bestDiscount(userId, casePrice) {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM case_discounts
       WHERE user_id = ? AND used_at IS NULL AND max_case_price >= ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY percent DESC, id ASC LIMIT 1`,
      [userId, casePrice, new Date().toISOString()]);
    return rows.failed || !rows.length ? null : rows[0];
  }

  async function history(userId, limit = 30) {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT sector_code, prize_json, created_at FROM wheel_rounds
       WHERE user_id = ? ORDER BY id DESC LIMIT ?`, [userId, Math.min(100, Math.max(1, limit))]);
    return rows.failed ? [] : rows.map(r => ({
      sectorCode: r.sector_code, createdAt: r.created_at,
      prize: (() => { try { return JSON.parse(r.prize_json).prize; } catch { return null; } })()
    }));
  }

  return { ensureSchema, state, spin, bestDiscount, history, sectorRing, pick,
    DEFAULT_SECTORS, DEPOSIT_STEP, MAX_BANKED };
}

module.exports = { makeWheelService, sectorRing, DEFAULT_SECTORS };
