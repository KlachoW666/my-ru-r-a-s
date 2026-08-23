'use strict';

/**
 * Кейс-баттлы (замесы).
 *
 * Было: список отдавался как статичный мок в памяти, create/join возвращали
 * success и ничего не меняли, розыгрыша не существовало вовсе.
 *
 * Стало: состояние в SQLite, реальные списания и выплаты, раунды разыгрываются
 * тем же взвешенным броском, что и обычные кейсы (services/drops.js), поэтому
 * RTP и настройки шансов действуют и здесь.
 *
 * Схема состояний: waiting -> running -> finished.
 * Победитель получает банк целиком; при равенстве сумм банк делится поровну.
 */

const crypto = require('crypto');
const { buildDistribution, rollOne, newServerSeed, DEFAULT_RTP } = require('./drops');

const BOT_NAMES = ['Кабан-бот', 'Рейдер', 'Сталкер', 'Барсук', 'Прапор', 'Тихий'];
const BOT_AVATAR = '/assets/battles/bot-badge.svg';

function makeBattlesService({ queryAdminDb, getAdminDb, getCaseItemsFromDb, getFallbackItems, fixImageUrl }) {
  let schemaReady = false;

  const run = (sql, params = []) => new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve(null);
    db.run(sql, params, function (err) { db.close(); resolve(err ? null : this); });
  });

  async function ensureSchema() {
    if (schemaReady) return;
    await run(`CREATE TABLE IF NOT EXISTS battles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      name TEXT,
      creator_id TEXT,
      creator_name TEXT,
      creator_avatar TEXT,
      max_players INTEGER DEFAULT 2,
      rounds INTEGER DEFAULT 1,
      case_slugs TEXT,
      total_price REAL DEFAULT 0,
      status TEXT DEFAULT 'waiting',
      winner_id TEXT,
      is_private INTEGER DEFAULT 0,
      server_seed TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP
    )`);
    await run(`CREATE TABLE IF NOT EXISTS battle_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      battle_id INTEGER,
      slot INTEGER,
      user_id TEXT,
      username TEXT,
      avatar TEXT,
      is_bot INTEGER DEFAULT 0,
      total_value REAL DEFAULT 0,
      UNIQUE(battle_id, slot)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS battle_drops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      battle_id INTEGER,
      round INTEGER,
      slot INTEGER,
      item_name TEXT,
      item_image TEXT,
      item_price REAL,
      item_rarity TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status, created_at)`);
    schemaReady = true;
  }

  // --- Чтение ---------------------------------------------------------------

  async function loadCases(slugs) {
    const out = [];
    for (const slug of slugs) {
      const rows = await queryAdminDb(`SELECT * FROM cases WHERE slug = ? OR id = ?`, [slug, slug]);
      const c = rows[0];
      if (!c) continue;
      let items = await getCaseItemsFromDb(c.id);
      if (!items || !items.length) items = await getFallbackItems();
      out.push({ row: c, items });
    }
    return out;
  }

  async function toDto(b, { withDrops = false } = {}) {
    const players = await queryAdminDb(
      `SELECT * FROM battle_players WHERE battle_id = ? ORDER BY slot ASC`, [b.id]);
    const slugs = JSON.parse(b.case_slugs || '[]');
    const cases = await queryAdminDb(
      slugs.length
        ? `SELECT slug, name, price, image FROM cases WHERE slug IN (${slugs.map(() => '?').join(',')})`
        : `SELECT slug, name, price, image FROM cases WHERE 0`, slugs);

    const dto = {
      id: b.uid,
      uid: b.uid,
      battleId: b.uid,
      name: b.name,
      status: b.status,
      rounds: b.rounds,
      totalPrice: b.total_price,
      maxPlayers: b.max_players,
      playersCount: players.length,
      isPrivate: b.is_private === 1,
      createdAt: b.created_at,
      finishedAt: b.finished_at,
      winnerId: b.winner_id,
      serverSeed: b.status === 'finished' ? b.server_seed : undefined,
      creator: { id: b.creator_id, username: b.creator_name, name: b.creator_name, avatar: b.creator_avatar },
      cases: cases.map(c => ({ slug: c.slug, id: c.slug, name: c.name, price: c.price, image: c.image })),
      players: players.map(p => ({
        slot: p.slot,
        id: p.user_id,
        userId: p.user_id,
        username: p.username,
        name: p.username,
        avatar: p.avatar,
        isBot: p.is_bot === 1,
        totalValue: p.total_value,
        isWinner: b.winner_id != null && String(p.user_id) === String(b.winner_id)
      }))
    };

    if (withDrops) {
      const drops = await queryAdminDb(
        `SELECT * FROM battle_drops WHERE battle_id = ? ORDER BY round ASC, slot ASC`, [b.id]);
      dto.drops = drops.map(d => ({
        round: d.round, slot: d.slot,
        name: d.item_name, image: d.item_image, price: d.item_price, rarity: d.item_rarity
      }));
    }
    return dto;
  }

  async function list({ status } = {}) {
    await ensureSchema();
    const where = status && status !== 'all' ? `WHERE status = ?` : '';
    const rows = await queryAdminDb(
      `SELECT * FROM battles ${where} ORDER BY
         CASE status WHEN 'waiting' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
         created_at DESC LIMIT 50`,
      status && status !== 'all' ? [status] : []);
    return Promise.all(rows.map(r => toDto(r)));
  }

  async function getByUid(uid, opts) {
    await ensureSchema();
    const rows = await queryAdminDb(`SELECT * FROM battles WHERE uid = ?`, [uid]);
    return rows[0] ? toDto(rows[0], opts) : null;
  }

  // --- Создание и вход ------------------------------------------------------

  async function create({ user, caseSlugs, rounds, maxPlayers, isPrivate, price }) {
    await ensureSchema();
    const uid = crypto.randomBytes(6).toString('hex');
    const { serverSeed } = newServerSeed();
    const countRow = await queryAdminDb(`SELECT COUNT(*) AS c FROM battles`);
    const num = (countRow[0]?.c || 0) + 1;

    const r = await run(
      `INSERT INTO battles (uid, name, creator_id, creator_name, creator_avatar, max_players,
                            rounds, case_slugs, total_price, status, is_private, server_seed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
      [uid, `Замес #${num}`, String(user.id), user.username, user.avatar,
       maxPlayers, rounds, JSON.stringify(caseSlugs), price, isPrivate ? 1 : 0, serverSeed]);
    if (!r) return null;

    await run(
      `INSERT INTO battle_players (battle_id, slot, user_id, username, avatar, is_bot)
       VALUES (?, 0, ?, ?, ?, 0)`,
      [r.lastID, String(user.id), user.username, user.avatar]);

    return { uid, battleId: uid, id: r.lastID };
  }

  async function join({ uid, user, asBot = false }) {
    await ensureSchema();
    const rows = await queryAdminDb(`SELECT * FROM battles WHERE uid = ?`, [uid]);
    const b = rows[0];
    if (!b) return { error: 'NOT_FOUND', message: 'Замес не найден' };
    if (b.status !== 'waiting') return { error: 'ALREADY_STARTED', message: 'Замес уже начался' };

    const players = await queryAdminDb(`SELECT * FROM battle_players WHERE battle_id = ?`, [b.id]);
    if (players.length >= b.max_players) return { error: 'FULL', message: 'Мест больше нет' };
    if (!asBot && players.some(p => String(p.user_id) === String(user.id))) {
      return { error: 'ALREADY_JOINED', message: 'Вы уже в этом замесе' };
    }

    const slot = players.length;
    if (asBot) {
      await run(
        `INSERT INTO battle_players (battle_id, slot, user_id, username, avatar, is_bot)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [b.id, slot, `bot-${b.id}-${slot}`, BOT_NAMES[slot % BOT_NAMES.length], BOT_AVATAR]);
    } else {
      await run(
        `INSERT INTO battle_players (battle_id, slot, user_id, username, avatar, is_bot)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [b.id, slot, String(user.id), user.username, user.avatar]);
    }

    const full = slot + 1 >= b.max_players;
    return { ok: true, full, battleDbId: b.id, uid };
  }

  // --- Розыгрыш -------------------------------------------------------------

  /**
   * Играет все раунды и определяет победителя.
   * Броски детерминированы по serverSeed баттла, поэтому результат
   * воспроизводится: HMAC(serverSeed, `${uid}:${round}:${slot}`).
   */
  async function play(battleDbId) {
    const rows = await queryAdminDb(`SELECT * FROM battles WHERE id = ?`, [battleDbId]);
    const b = rows[0];
    if (!b || b.status !== 'waiting') return null;

    await run(`UPDATE battles SET status = 'running' WHERE id = ?`, [battleDbId]);

    const players = await queryAdminDb(
      `SELECT * FROM battle_players WHERE battle_id = ? ORDER BY slot ASC`, [battleDbId]);
    const slugs = JSON.parse(b.case_slugs || '[]');
    const cases = await loadCases(slugs);
    const totals = new Map(players.map(p => [p.slot, 0]));

    for (let round = 0; round < b.rounds; round++) {
      for (const c of cases) {
        const dist = buildDistribution(c.items, {
          casePrice: c.row.price || 49,
          rtp: DEFAULT_RTP
        });
        if (!dist.entries.length) continue;

        for (const p of players) {
          const { item } = rollOne(dist, {
            serverSeed: b.server_seed,
            clientSeed: `${b.uid}:${c.row.slug}`,
            nonce: round * 100 + p.slot
          });
          if (!item) continue;
          const price = Number(item.price) || 0;
          totals.set(p.slot, (totals.get(p.slot) || 0) + price);
          await run(
            `INSERT INTO battle_drops (battle_id, round, slot, item_name, item_image, item_price, item_rarity)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [battleDbId, round, p.slot, item.name, fixImageUrl(item.image), price, item.rarity]);
        }
      }
    }

    for (const p of players) {
      await run(`UPDATE battle_players SET total_value = ? WHERE id = ?`, [totals.get(p.slot) || 0, p.id]);
    }

    // Победитель — наибольшая сумма. При равенстве побеждает меньший слот,
    // а банк делится между всеми, кто набрал максимум.
    const best = Math.max(...players.map(p => totals.get(p.slot) || 0));
    const winners = players.filter(p => (totals.get(p.slot) || 0) === best);
    const pot = Number(b.total_price) * players.length;
    const share = winners.length ? Math.round(pot / winners.length) : 0;

    await run(`UPDATE battles SET status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [String(winners[0]?.user_id ?? ''), battleDbId]);

    return {
      uid: b.uid,
      winners: winners.map(w => ({ userId: w.user_id, slot: w.slot, isBot: w.is_bot === 1, share })),
      pot,
      totals: Object.fromEntries(totals)
    };
  }

  return { ensureSchema, list, getByUid, create, join, play, loadCases };
}

module.exports = { makeBattlesService };
