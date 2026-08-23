'use strict';

/**
 * Розыгрыши.
 *
 * Было: статичный мок в памяти — список из одной записи, join всегда отвечал
 * success и ничего не сохранял, победитель не определялся никогда.
 *
 * Стало: розыгрыши и участники в SQLite, победитель выбирается честным броском
 * (HMAC от серверного сида), приз зачисляется на баланс. Завершение проверяется
 * по таймеру раз в 30 секунд.
 */

const crypto = require('crypto');
const { fairFloat, newServerSeed } = require('./drops');

function makeGiveawaysService({ queryAdminDb, getAdminDb, queryItems, adjustBalanceById, fixImageUrl }) {
  let schemaReady = false;
  let timer = null;

  const run = (sql, params = []) => new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve(null);
    db.run(sql, params, function (err) { db.close(); resolve(err ? null : this); });
  });

  async function ensureSchema() {
    if (schemaReady) return;
    await run(`CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      title TEXT,
      item_name TEXT,
      item_image TEXT,
      item_price REAL,
      item_rarity TEXT,
      kind TEXT DEFAULT 'daily',
      min_deposit REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      ends_at INTEGER,
      winner_id TEXT,
      winner_name TEXT,
      server_seed TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(`CREATE TABLE IF NOT EXISTS giveaway_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      giveaway_id INTEGER,
      user_id TEXT,
      username TEXT,
      avatar TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(giveaway_id, user_id)
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status, ends_at)`);
    schemaReady = true;
  }

  // --- Наполнение -----------------------------------------------------------

  /** Заводит ежедневный и мега-розыгрыш, если активных нет. */
  async function seedIfEmpty() {
    await ensureSchema();
    const active = await queryAdminDb(`SELECT COUNT(*) AS c FROM giveaways WHERE status = 'active'`);
    if ((active[0]?.c || 0) > 0) return 0;

    const daily = await queryItems({ minPrice: 800, maxPrice: 6000, limit: 30, sort: 'desc' });
    const mega = await queryItems({ minPrice: 15000, limit: 20, sort: 'desc' });
    const pickOne = (r) => r.items.length ? r.items[Math.floor(Math.random() * r.items.length)] : null;

    const plan = [
      { kind: 'daily', title: 'Ежедневный розыгрыш', item: pickOne(daily), hours: 24 },
      { kind: 'mega', title: 'Мега розыгрыш месяца', item: pickOne(mega) || pickOne(daily), hours: 24 * 7 }
    ];

    let created = 0;
    for (const p of plan) {
      if (!p.item) continue;
      const { serverSeed } = newServerSeed();
      const r = await run(
        `INSERT INTO giveaways (uid, title, item_name, item_image, item_price, item_rarity,
                                kind, min_deposit, status, ends_at, server_seed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [crypto.randomBytes(5).toString('hex'), p.title, p.item.name, p.item.image,
         p.item.price, p.item.rarity, p.kind, p.kind === 'mega' ? 1000 : 0,
         Date.now() + p.hours * 3600 * 1000, serverSeed]);
      if (r) created++;
    }
    if (created) console.log(`[Giveaways] Создано розыгрышей: ${created}`);
    return created;
  }

  // --- Чтение ---------------------------------------------------------------

  async function toDto(g) {
    const rows = await queryAdminDb(
      `SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id = ?`, [g.id]);
    return {
      id: g.uid,
      uid: g.uid,
      title: g.title,
      kind: g.kind,
      prize: g.item_name,
      price: g.item_price,
      image: fixImageUrl(g.item_image),
      rarity: g.item_rarity,
      minDeposit: g.min_deposit,
      participantsCount: rows[0]?.c || 0,
      status: g.status,
      endsAt: new Date(Number(g.ends_at)).toISOString(),
      winner: g.winner_id ? { id: g.winner_id, username: g.winner_name } : null,
      serverSeed: g.status === 'finished' ? g.server_seed : undefined
    };
  }

  async function list({ status = 'active' } = {}) {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM giveaways WHERE status = ? ORDER BY ends_at ASC LIMIT 50`, [status]);
    return Promise.all(rows.map(toDto));
  }

  async function history() {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM giveaways WHERE status = 'finished' ORDER BY ends_at DESC LIMIT 50`);
    return Promise.all(rows.map(toDto));
  }

  async function activeMega() {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM giveaways WHERE status = 'active' AND kind = 'mega' ORDER BY ends_at ASC LIMIT 1`);
    return rows[0] ? toDto(rows[0]) : null;
  }

  async function participants(uid) {
    const g = (await queryAdminDb(`SELECT id FROM giveaways WHERE uid = ?`, [uid]))[0];
    if (!g) return [];
    const rows = await queryAdminDb(
      `SELECT user_id, username, avatar, created_at FROM giveaway_entries
       WHERE giveaway_id = ? ORDER BY id ASC LIMIT 500`, [g.id]);
    return rows.map(r => ({ id: r.user_id, username: r.username, avatar: r.avatar, joinedAt: r.created_at }));
  }

  // --- Участие --------------------------------------------------------------

  async function join({ uid, user, depositTotal = 0 }) {
    await ensureSchema();
    const g = (await queryAdminDb(`SELECT * FROM giveaways WHERE uid = ? OR id = ?`, [uid, uid]))[0];
    if (!g) return { error: 'NOT_FOUND', message: 'Розыгрыш не найден' };
    if (g.status !== 'active') return { error: 'FINISHED', message: 'Розыгрыш уже завершён' };
    if (Date.now() > Number(g.ends_at)) return { error: 'FINISHED', message: 'Приём заявок закрыт' };
    if (!user || user.isGuest) return { error: 'UNAUTHORIZED', message: 'Нужна авторизация' };
    if (g.min_deposit > 0 && depositTotal < g.min_deposit) {
      return { error: 'MIN_DEPOSIT', message: `Нужен депозит от ${g.min_deposit} ₽` };
    }

    const exists = await queryAdminDb(
      `SELECT id FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`, [g.id, String(user.id)]);
    if (exists.length) return { error: 'ALREADY_JOINED', message: 'Вы уже участвуете' };

    await run(`INSERT INTO giveaway_entries (giveaway_id, user_id, username, avatar) VALUES (?, ?, ?, ?)`,
      [g.id, String(user.id), user.username, user.avatar]);

    const cnt = await queryAdminDb(`SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id = ?`, [g.id]);
    return { ok: true, participantsCount: cnt[0]?.c || 0 };
  }

  // --- Завершение -----------------------------------------------------------

  /** Разыгрывает все розыгрыши, у которых истёк срок. */
  async function finishDue() {
    await ensureSchema();
    const due = await queryAdminDb(
      `SELECT * FROM giveaways WHERE status = 'active' AND ends_at <= ?`, [Date.now()]);

    for (const g of due) {
      const entries = await queryAdminDb(
        `SELECT * FROM giveaway_entries WHERE giveaway_id = ? ORDER BY id ASC`, [g.id]);

      if (!entries.length) {
        // Без участников продлеваем, а не отменяем: иначе блок опустеет навсегда.
        await run(`UPDATE giveaways SET ends_at = ? WHERE id = ?`,
          [Date.now() + (g.kind === 'mega' ? 7 * 24 : 24) * 3600 * 1000, g.id]);
        continue;
      }

      // Честный выбор: бросок по серверному сиду и числу участников.
      const roll = fairFloat(g.server_seed, `${g.uid}:winner`, entries.length);
      const winner = entries[Math.min(entries.length - 1, Math.floor(roll * entries.length))];

      await run(`UPDATE giveaways SET status = 'finished', winner_id = ?, winner_name = ? WHERE id = ?`,
        [winner.user_id, winner.username, g.id]);

      // Инвентаря нет, поэтому приз зачисляется деньгами — как и выигрыш в кейсе.
      await adjustBalanceById(winner.user_id, Number(g.item_price) || 0,
        'giveaway_win', `Розыгрыш: ${g.item_name}`);

      console.log(`[Giveaways] "${g.title}" — победитель ${winner.username} (${entries.length} участников)`);
    }

    await seedIfEmpty();
    return due.length;
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => { finishDue().catch(() => {}); }, 30000);
    if (timer.unref) timer.unref();
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    ensureSchema, seedIfEmpty, list, history, activeMega, participants,
    join, finishDue, startTimer, stopTimer
  };
}

module.exports = { makeGiveawaysService };
