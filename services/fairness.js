'use strict';

/**
 * Provably fair: фиксация серверного сида ДО игры.
 *
 * Было: сид генерировался на каждое открытие и тут же раскрывался в ответе.
 * Бросок можно было пересчитать постфактум, но доказать, что сервер не подобрал
 * сид под нужный результат, — нельзя. Это не provably fair, а просто
 * воспроизводимый бросок.
 *
 * Стало: у игрока есть активная пара сидов.
 *   1. Сервер генерирует serverSeed и публикует ТОЛЬКО sha256 от него.
 *   2. Игрок видит хэш заранее и может задать свой clientSeed.
 *   3. Каждая игра увеличивает nonce; бросок = HMAC(serverSeed, clientSeed:nonce).
 *   4. При смене пары старый serverSeed раскрывается — и все прошлые броски
 *      можно проверить против опубликованного ранее хэша.
 *
 * Подмена сида задним числом становится заметной: хэш был опубликован до игр.
 */

const crypto = require('crypto');

function makeFairnessService({ queryAdminDb, getAdminDb }) {
  let schemaReady = false;

  const run = (sql, params = []) => new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve(null);
    db.run(sql, params, function (err) { db.close(); resolve(err ? null : this); });
  });

  async function ensureSchema() {
    if (schemaReady) return;
    await run(`CREATE TABLE IF NOT EXISTS fair_seeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      server_seed TEXT,
      server_hash TEXT,
      client_seed TEXT,
      nonce INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      revealed_at TIMESTAMP)`);

    await run(`CREATE TABLE IF NOT EXISTS fair_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      seed_id INTEGER,
      game TEXT,
      nonce INTEGER,
      roll REAL,
      result TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await run(`CREATE INDEX IF NOT EXISTS idx_fair_seed_user ON fair_seeds(user_id, status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_fair_rounds ON fair_rounds(user_id, seed_id, nonce)`);
    schemaReady = true;
  }

  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

  /** Бросок [0,1) — та же формула, что в drops.js, чтобы результат совпадал. */
  function roll(serverSeed, clientSeed, nonce) {
    const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
    return parseInt(h.slice(0, 8), 16) / 0x100000000;
  }

  /** Активная пара сидов игрока; создаётся при первом обращении. */
  async function getActive(userId) {
    await ensureSchema();
    const uid = String(userId);
    const rows = await queryAdminDb(
      `SELECT * FROM fair_seeds WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [uid]);
    if (rows[0]) return rows[0];

    const serverSeed = crypto.randomBytes(32).toString('hex');
    const clientSeed = crypto.randomBytes(8).toString('hex');
    await run(
      `INSERT INTO fair_seeds (user_id, server_seed, server_hash, client_seed, nonce, status)
       VALUES (?, ?, ?, ?, 0, 'active')`,
      [uid, serverSeed, sha256(serverSeed), clientSeed]);
    const created = await queryAdminDb(
      `SELECT * FROM fair_seeds WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [uid]);
    return created[0];
  }

  /** Что можно показать игроку до игры: хэш, но не сам сид. */
  async function publicState(userId) {
    const s = await getActive(userId);
    const prev = await queryAdminDb(
      `SELECT server_seed, server_hash, client_seed, nonce, revealed_at
       FROM fair_seeds WHERE user_id = ? AND status = 'revealed' ORDER BY id DESC LIMIT 5`, [String(userId)]);
    return {
      serverHash: s.server_hash,
      clientSeed: s.client_seed,
      nonce: s.nonce,
      // serverSeed намеренно НЕ отдаётся: он раскрывается только при смене пары.
      previous: prev.map(p => ({
        serverSeed: p.server_seed, serverHash: p.server_hash,
        clientSeed: p.client_seed, rounds: p.nonce, revealedAt: p.revealed_at
      }))
    };
  }

  /** Игрок задаёт свой clientSeed — это его вклад в результат. */
  async function setClientSeed(userId, clientSeed) {
    const s = await getActive(userId);
    const seed = String(clientSeed || '').trim().slice(0, 64);
    if (!seed) return { error: 'EMPTY', message: 'Клиентский сид не может быть пустым' };
    await run(`UPDATE fair_seeds SET client_seed = ? WHERE id = ?`, [seed, s.id]);
    return publicState(userId);
  }

  /**
   * Смена пары: старый сид раскрывается, новый получает новый хэш.
   * После этого все прошлые броски проверяемы.
   */
  async function rotate(userId) {
    const s = await getActive(userId);
    await run(`UPDATE fair_seeds SET status = 'revealed', revealed_at = CURRENT_TIMESTAMP WHERE id = ?`, [s.id]);
    const next = await getActive(userId);
    return {
      revealed: { serverSeed: s.server_seed, serverHash: s.server_hash, clientSeed: s.client_seed, rounds: s.nonce },
      current: { serverHash: next.server_hash, clientSeed: next.client_seed, nonce: next.nonce }
    };
  }

  /**
   * Взять следующий бросок и записать раунд.
   * @returns {{ roll, nonce, serverHash, clientSeed, seedId }}
   */
  async function nextRoll(userId, game, count = 1) {
    const s = await getActive(userId);
    const rolls = [];
    for (let i = 0; i < count; i++) {
      const nonce = s.nonce + i;
      rolls.push({ nonce, roll: roll(s.server_seed, s.client_seed, nonce) });
    }
    await run(`UPDATE fair_seeds SET nonce = ? WHERE id = ?`, [s.nonce + count, s.id]);
    for (const r of rolls) {
      await run(`INSERT INTO fair_rounds (user_id, seed_id, game, nonce, roll) VALUES (?, ?, ?, ?, ?)`,
        [String(userId), s.id, game, r.nonce, r.roll]);
    }
    return { rolls, serverHash: s.server_hash, clientSeed: s.client_seed, seedId: s.id, startNonce: s.nonce };
  }

  /** Проверка чужими руками: сид, клиентский сид и нонс дают тот же бросок. */
  function verify({ serverSeed, clientSeed, nonce }) {
    if (!serverSeed || clientSeed == null || nonce == null) {
      return { error: 'BAD_INPUT', message: 'Нужны serverSeed, clientSeed и nonce' };
    }
    return {
      serverHash: sha256(serverSeed),
      roll: roll(serverSeed, String(clientSeed), Number(nonce)),
      formula: 'HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}`) -> первые 8 hex / 0x100000000'
    };
  }

  async function history(userId, limit = 50) {
    await ensureSchema();
    return queryAdminDb(
      `SELECT r.game, r.nonce, r.roll, r.created_at, s.server_hash, s.client_seed,
              CASE WHEN s.status = 'revealed' THEN s.server_seed ELSE NULL END AS server_seed
       FROM fair_rounds r JOIN fair_seeds s ON s.id = r.seed_id
       WHERE r.user_id = ? ORDER BY r.id DESC LIMIT ?`, [String(userId), limit]);
  }

  return { ensureSchema, getActive, publicState, setClientSeed, rotate, nextRoll, verify, history, roll, sha256 };
}

module.exports = { makeFairnessService };
