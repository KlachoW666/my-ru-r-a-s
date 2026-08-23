'use strict';

/**
 * Инвентарь игрока и вывод скинов.
 *
 * Было: выигранный предмет сразу превращался в деньги на балансе, инвентаря не
 * существовало, вывести скин было нельзя.
 *
 * Стало: выигрыш попадает в инвентарь как предмет. Дальше игрок либо продаёт
 * его по цене каталога, либо заказывает вывод на свой Steam trade-link.
 *
 * Поведение переключается переменной AUTO_SELL_WINS=1 — тогда предмет
 * записывается в инвентарь сразу как проданный, а деньги идут на баланс, как
 * было раньше. По умолчанию 0: предмет остаётся предметом.
 *
 * Контракт снят с бандла (wallet-rLlmihs3.js):
 *   GET  /wallet/skins/withdraw-inventory   — что можно вывести
 *   GET  /wallet/skins/withdrawals          — заявки на вывод
 *   POST /wallet/withdrawals/:id/cancel     — отменить заявку
 */

const crypto = require('crypto');

/** 1 — старое поведение: выигрыш сразу деньгами. */
const AUTO_SELL = process.env.AUTO_SELL_WINS === '1';

/** Комиссия площадки при продаже предмета обратно, %. */
const SELL_FEE_PERCENT = Number(process.env.SELL_FEE_PERCENT || 0);

const TRADE_LINK_RE = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+$/;

function makeInventoryService({ queryAdminDb, getAdminDb, adjustBalanceById, recordTransactionById, fixImageUrl }) {
  let schemaReady = false;

  const run = (sql, params = []) => new Promise((resolve) => {
    const db = getAdminDb();
    if (!db) return resolve(null);
    db.run(sql, params, function (err) { db.close(); resolve(err ? null : this); });
  });

  async function ensureSchema() {
    if (schemaReady) return;
    await run(`CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      item_id INTEGER,
      market_hash_name TEXT,
      name TEXT,
      image TEXT,
      price REAL DEFAULT 0,
      rarity TEXT,
      color TEXT,
      source TEXT,
      source_ref TEXT,
      status TEXT DEFAULT 'owned',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await run(`CREATE TABLE IF NOT EXISTS skin_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      user_id TEXT,
      trade_link TEXT,
      total_price REAL DEFAULT 0,
      items_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await run(`CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(user_id, status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_skinwd_user ON skin_withdrawals(user_id, status)`);
    schemaReady = true;
  }

  const dto = (r) => ({
    id: r.id,
    itemId: r.item_id,
    marketHashName: r.market_hash_name,
    name: r.name,
    image: fixImageUrl(r.image),
    price: r.price,
    priceText: `${r.price} ₽`,
    rarity: r.rarity,
    color: r.color,
    source: r.source,
    status: r.status,
    createdAt: r.created_at
  });

  // ---------------------------------------------------------------------------
  // Начисление выигрыша
  // ---------------------------------------------------------------------------

  /**
   * Кладёт предмет в инвентарь.
   * @returns {Promise<{mode:'inventory'|'sold', value:number, id:number|null}>}
   */
  async function award(userId, item, { source = 'case', ref = '' } = {}) {
    await ensureSchema();
    const price = Math.round(Number(item.price) || 0);
    const status = AUTO_SELL ? 'sold' : 'owned';

    const numericId = typeof item.id === 'string' && item.id.startsWith('db-')
      ? parseInt(item.id.slice(3), 10) : (parseInt(item.id, 10) || null);

    const r = await run(
      `INSERT INTO inventory (user_id, item_id, market_hash_name, name, image, price, rarity, color, source, source_ref, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(userId), numericId, item.marketHashName || item.name, item.name,
       item.image, price, item.rarity, item.color || item.colorHex, source, ref, status]);

    if (AUTO_SELL) {
      await adjustBalanceById(userId, price, source + '_win', item.name);
      return { mode: 'sold', value: price, id: r ? r.lastID : null };
    }
    return { mode: 'inventory', value: price, id: r ? r.lastID : null };
  }

  // ---------------------------------------------------------------------------
  // Чтение
  // ---------------------------------------------------------------------------

  async function list(userId, { status = 'owned', limit = 200 } = {}) {
    await ensureSchema();
    const where = status === 'all' ? '' : ' AND status = ?';
    const params = status === 'all' ? [String(userId)] : [String(userId), status];
    const rows = await queryAdminDb(
      `SELECT * FROM inventory WHERE user_id = ?${where} ORDER BY price DESC, id DESC LIMIT ?`,
      [...params, limit]);
    const total = rows.reduce((a, r) => a + (Number(r.price) || 0), 0);
    return { items: rows.map(dto), count: rows.length, totalValue: total };
  }

  // ---------------------------------------------------------------------------
  // Продажа
  // ---------------------------------------------------------------------------

  async function sell(userId, ids) {
    await ensureSchema();
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
    if (!list.length) return { error: 'NO_ITEMS', message: 'Не выбрано ни одного предмета' };

    const rows = await queryAdminDb(
      `SELECT * FROM inventory WHERE user_id = ? AND status = 'owned' AND id IN (${list.map(() => '?').join(',')})`,
      [String(userId), ...list]);
    if (!rows.length) return { error: 'NOT_FOUND', message: 'Предметы не найдены в инвентаре' };

    const gross = rows.reduce((a, r) => a + (Number(r.price) || 0), 0);
    const payout = Math.round(gross * (1 - SELL_FEE_PERCENT / 100));

    await run(
      `UPDATE inventory SET status = 'sold', updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map(r => r.id));

    const balance = await adjustBalanceById(userId, payout, 'item_sell',
      rows.length === 1 ? rows[0].name : `Продажа предметов: ${rows.length} шт.`);

    return { ok: true, sold: rows.length, gross, payout, feePercent: SELL_FEE_PERCENT, balance };
  }

  async function sellAll(userId) {
    const inv = await list(userId, { status: 'owned', limit: 1000 });
    if (!inv.items.length) return { error: 'EMPTY', message: 'Инвентарь пуст' };
    return sell(userId, inv.items.map(i => i.id));
  }

  // ---------------------------------------------------------------------------
  // Вывод скинов
  // ---------------------------------------------------------------------------

  /**
   * Заявка на вывод. Реальную отправку трейд-оффера здесь не делаем: для этого
   * нужен отдельный Steam-бот с сессией (steam-user + steam-tradeoffer-manager)
   * и его учётные данные. Заявка уходит в админку, раздел «Выводы».
   */
  async function requestWithdraw(userId, ids, tradeLink) {
    await ensureSchema();
    if (!TRADE_LINK_RE.test(String(tradeLink || ''))) {
      return { error: 'BAD_TRADE_LINK', message: 'Укажите корректную ссылку для обмена Steam в профиле' };
    }

    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
    if (!list.length) return { error: 'NO_ITEMS', message: 'Не выбрано ни одного предмета' };

    const rows = await queryAdminDb(
      `SELECT * FROM inventory WHERE user_id = ? AND status = 'owned' AND id IN (${list.map(() => '?').join(',')})`,
      [String(userId), ...list]);
    if (!rows.length) return { error: 'NOT_FOUND', message: 'Предметы не найдены в инвентаре' };

    const uid = crypto.randomBytes(6).toString('hex');
    const total = rows.reduce((a, r) => a + (Number(r.price) || 0), 0);

    const r = await run(
      `INSERT INTO skin_withdrawals (uid, user_id, trade_link, total_price, items_count, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [uid, String(userId), tradeLink, total, rows.length]);
    if (!r) return { error: 'DB', message: 'Не удалось создать заявку' };

    // Предметы блокируются, чтобы их нельзя было продать дважды.
    await run(
      `UPDATE inventory SET status = 'withdraw_pending', source_ref = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${rows.map(() => '?').join(',')})`, [uid, ...rows.map(x => x.id)]);

    return { ok: true, uid, itemsCount: rows.length, totalPrice: total, status: 'pending' };
  }

  async function listWithdrawals(userId) {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM skin_withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100`, [String(userId)]);
    const out = [];
    for (const w of rows) {
      const items = await queryAdminDb(
        `SELECT * FROM inventory WHERE source_ref = ? AND user_id = ?`, [w.uid, String(userId)]);
      out.push({
        id: w.uid, uid: w.uid, status: w.status, tradeLink: w.trade_link,
        totalPrice: w.total_price, itemsCount: w.items_count,
        comment: w.comment, createdAt: w.created_at,
        items: items.map(dto)
      });
    }
    return out;
  }

  /** Отмена возвращает предметы в инвентарь. */
  async function cancelWithdraw(userId, uid) {
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT * FROM skin_withdrawals WHERE uid = ? AND user_id = ?`, [uid, String(userId)]);
    const w = rows[0];
    if (!w) return { error: 'NOT_FOUND', message: 'Заявка не найдена' };
    if (w.status !== 'pending') return { error: 'ALREADY_PROCESSED', message: 'Заявка уже обработана' };

    await run(`UPDATE skin_withdrawals SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [w.id]);
    await run(`UPDATE inventory SET status = 'owned', updated_at = CURRENT_TIMESTAMP WHERE source_ref = ? AND status = 'withdraw_pending'`, [uid]);
    return { ok: true, uid, status: 'cancelled' };
  }

  /** Статистика профиля — считается по инвентарю и транзакциям, а не мокается. */
  async function userStats(userId) {
    await ensureSchema();
    const one = async (sql, p) => Number((await queryAdminDb(sql, p))[0]?.v || 0);
    const opened = await one(`SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'case_open'`, [userId]);
    const battles = await one(`SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'battle_entry'`, [userId]);
    const upgrades = await one(`SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'upgrade'`, [userId]);
    const won = await one(`SELECT COALESCE(SUM(price),0) AS v FROM inventory WHERE user_id = ?`, [userId]);
    const best = (await queryAdminDb(
      `SELECT name, price, image, rarity FROM inventory WHERE user_id = ? ORDER BY price DESC LIMIT 1`, [userId]))[0] || null;
    const inv = await list(userId, { status: 'owned', limit: 1000 });
    return {
      openedCases: opened, totalBattles: battles, upgrades,
      wonAmount: Math.round(won),
      inventoryCount: inv.count, inventoryValue: Math.round(inv.totalValue),
      bestDrop: best ? { name: best.name, price: best.price, image: fixImageUrl(best.image), rarity: best.rarity } : null
    };
  }

  return {
    ensureSchema, award, list, sell, sellAll,
    requestWithdraw, listWithdrawals, cancelWithdraw, userStats,
    AUTO_SELL, TRADE_LINK_RE
  };
}

module.exports = { makeInventoryService };
