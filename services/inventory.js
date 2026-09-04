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
const { transaction } = require('./sqliteTransaction');
const cents = value => {
  const n = Number(value), c = Math.round(n * 100);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(c)) throw new Error('Некорректная сумма');
  return c;
};

/** 1 — старое поведение: выигрыш сразу деньгами. */
const AUTO_SELL = process.env.AUTO_SELL_WINS === '1';

/** Комиссия площадки при продаже предмета обратно, %. */
const SELL_FEE_PERCENT = Number(process.env.SELL_FEE_PERCENT || 0);

const TRADE_LINK_RE = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+$/;

function makeInventoryService({ queryAdminDb, getAdminDb, adjustBalanceById, recordTransactionById, fixImageUrl }) {
  let schemaReady = false;

  const run = (sql, params = []) => new Promise((resolve, reject) => {
    const db = getAdminDb();
    if (!db) return reject(new Error('Database unavailable'));
    db.configure('busyTimeout', 5000);
    db.run(sql, params, function (err) { const result={lastID:this.lastID,changes:this.changes}; db.close(()=>err?reject(err):resolve(result)); });
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
    return transaction(getAdminDb, tx => awardInTransaction(tx, userId, item, {source,ref}));
  }

  async function awardInTransaction(tx, userId, item, {source='case',ref=''}={}) {
    const price = cents(item.price) / 100;
    const status = AUTO_SELL ? 'sold' : 'owned';

    const numericId = typeof item.id === 'string' && item.id.startsWith('db-')
      ? parseInt(item.id.slice(3), 10) : (parseInt(item.id, 10) || null);

    const r = await tx.run(
      `INSERT INTO inventory (user_id, item_id, market_hash_name, name, image, price, rarity, color, source, source_ref, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(userId), numericId, item.marketHashName || item.name, item.name,
       item.image, price, item.rarity, item.color || item.colorHex, source, ref, status]);

    if (AUTO_SELL) {
      const credited = await tx.run('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?',[price,userId]);
      if (credited.changes !== 1) throw new Error('Пользователь не найден');
      await tx.run('INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',[userId,source+'_win',price,item.name]);
      return { mode: 'sold', value: price, id: r ? r.lastID : null };
    }
    return { mode: 'inventory', value: price, id: r ? r.lastID : null };
  }

  // The entire opening either commits or leaves both money and inventory intact.
  async function settleCase(userId, {cost, drops, ref}) {
    await ensureSchema();
    const costCents=cents(cost);
    if (!Array.isArray(drops) || !drops.length || drops.length>5) throw new Error('Некорректное количество кейсов');
    drops.forEach(d=>cents(d.price));
    return transaction(getAdminDb, async tx=>{
      const debit=await tx.run('UPDATE users SET balance=ROUND(balance-?,2) WHERE id=? AND ROUND(balance*100)>=?', [costCents/100,userId,costCents]);
      if(debit.changes!==1) throw Object.assign(new Error('Недостаточно средств или баланс недоступен'),{code:'INSUFFICIENT_BALANCE',status:400});
      const awards=[];
      for(const d of drops) awards.push(await awardInTransaction(tx,userId,d,{source:'case',ref}));
      await tx.run('INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',[userId,'case_open',-costCents/100,`Открытие: ${ref} x${drops.length}`]);
      const balance=(await tx.get('SELECT balance FROM users WHERE id=?',[userId])).balance;
      return {balance,newBalance:balance,winnings:awards.reduce((sum,a)=>sum+cents(a.value),0)/100,
        rewardDestination:AUTO_SELL?'balance':'inventory',inventoryIds:awards.map(a=>a.id),
        sellFeePercent:SELL_FEE_PERCENT};
    });
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
    if(rows.failed) throw new Error('Инвентарь временно недоступен');
    const total = rows.reduce((a, r) => a + (Number(r.price) || 0), 0);
    return { items: rows.map(dto), count: rows.length, totalValue: total };
  }

  // ---------------------------------------------------------------------------
  // Продажа
  // ---------------------------------------------------------------------------

  async function sell(userId, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))];
    if(list.some(id=>!Number.isSafeInteger(id)||id<=0)||list.length>1000) return {error:'INVALID_ITEMS',message:'Некорректный список предметов'};
    if (!list.length) return { error: 'NO_ITEMS', message: 'Не выбрано ни одного предмета' };
    try {
    await ensureSchema();
    if(!Number.isFinite(SELL_FEE_PERCENT)||SELL_FEE_PERCENT<0||SELL_FEE_PERCENT>100) throw new Error('Invalid sell fee');
    return await transaction(getAdminDb,async tx=>{
    const rows = await tx.all(
      `SELECT * FROM inventory WHERE user_id = ? AND status = 'owned' AND id IN (${list.map(() => '?').join(',')})`,
      [String(userId), ...list]);
    if (rows.length !== list.length) return { error: 'NOT_FOUND', message: 'Часть предметов уже продана, выведена или недоступна. Обновите инвентарь.' };

    const grossCents = rows.reduce((a, r) => a + cents(r.price), 0);
    const gross = grossCents / 100;
    const payout = Math.round(grossCents * (1 - SELL_FEE_PERCENT / 100)) / 100;

    await tx.run(
      `UPDATE inventory SET status = 'sold', updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map(r => r.id));

    const credited=await tx.run('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?',[payout,userId]);
    if(credited.changes!==1) throw new Error('Пользователь не найден');
    await tx.run('INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',[userId,'item_sell',payout,`Продажа предметов: ${rows.length} шт.`]);
    const balance=(await tx.get('SELECT balance FROM users WHERE id=?',[userId])).balance;

    return { ok: true, sold: rows.length, gross, payout, feePercent: SELL_FEE_PERCENT, balance };
    });
    } catch(error) { console.error('[Inventory sale]',error.message); return {error:'DB',message:'Продажа не выполнена. Предметы и баланс не изменены; попробуйте снова.'}; }
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
    if (!TRADE_LINK_RE.test(String(tradeLink || ''))) {
      return { error: 'BAD_TRADE_LINK', message: 'Укажите корректную ссылку для обмена Steam в профиле' };
    }

    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))];
    if (list.some(id => !Number.isSafeInteger(id) || id <= 0) || list.length > 1000) {
      return { error: 'INVALID_ITEMS', message: 'Некорректный список предметов' };
    }
    if (!list.length) return { error: 'NO_ITEMS', message: 'Не выбрано ни одного предмета' };
    try {
    await ensureSchema();
    return await transaction(getAdminDb, async tx => {
    const rows = await tx.all(
      `SELECT * FROM inventory WHERE user_id = ? AND status = 'owned' AND id IN (${list.map(() => '?').join(',')})`,
      [String(userId), ...list]);
    if (rows.length !== list.length) return { error: 'NOT_FOUND', message: 'Часть предметов уже продана, выведена или недоступна. Обновите инвентарь.' };

    const uid = crypto.randomBytes(6).toString('hex');
    const total = rows.reduce((a, r) => a + cents(r.price), 0) / 100;

    await tx.run(
      `INSERT INTO skin_withdrawals (uid, user_id, trade_link, total_price, items_count, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [uid, String(userId), tradeLink, total, rows.length]);

    // Same write transaction as the selection: a concurrent sale/withdrawal
    // cannot claim the selected items between reading and locking them.
    await tx.run(
      `UPDATE inventory SET status = 'withdraw_pending', source_ref = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${rows.map(() => '?').join(',')})`, [uid, ...rows.map(x => x.id)]);

    return { ok: true, uid, itemsCount: rows.length, totalPrice: total, status: 'pending' };
    });
    } catch (error) {
      console.error('[Inventory withdrawal]', error.message);
      return { error: 'DB', message: 'Заявка не создана. Предметы не изменены; попробуйте снова.' };
    }
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
    try {
    await ensureSchema();
    return await transaction(getAdminDb, async tx => {
    const rows = await tx.all(
      `SELECT * FROM skin_withdrawals WHERE uid = ? AND user_id = ?`, [uid, String(userId)]);
    const w = rows[0];
    if (!w) return { error: 'NOT_FOUND', message: 'Заявка не найдена' };
    if (w.status !== 'pending') return { error: 'ALREADY_PROCESSED', message: 'Заявка уже обработана' };

    await tx.run(`UPDATE skin_withdrawals SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [w.id]);
    await tx.run(`UPDATE inventory SET status = 'owned', updated_at = CURRENT_TIMESTAMP WHERE source_ref = ? AND user_id = ? AND status = 'withdraw_pending'`, [uid, String(userId)]);
    return { ok: true, uid, status: 'cancelled' };
    });
    } catch (error) {
      console.error('[Inventory cancellation]', error.message);
      return { error: 'DB', message: 'Отмена не выполнена. Заявка и предметы не изменены; попробуйте снова.' };
    }
  }

  /** Статистика профиля — считается по инвентарю и транзакциям, а не мокается. */
  async function userStats(userId) {
    await ensureSchema();
    const one = async (sql, p) => Number((await queryAdminDb(sql, p))[0]?.v || 0);
    const caseRows = await queryAdminDb(`SELECT comment FROM transactions WHERE user_id = ? AND type = 'case_open'`, [userId]);
    if (caseRows.failed) throw new Error('Статистика профиля временно недоступна');
    const opened = caseRows.reduce((sum, row) => {
      const quantity = String(row.comment || '').match(/\bx(\d+)\s*$/i);
      return sum + Math.max(1, Number(quantity?.[1]) || 1);
    }, 0);
    const battles = await one(`SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'battle_entry'`, [userId]);
    const upgrades = await one(`SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'upgrade'`, [userId]);
    const won = await one(`SELECT COALESCE(SUM(price),0) AS v FROM inventory WHERE user_id = ?`, [userId]);
    const best = (await queryAdminDb(
      `SELECT name, price, image, rarity FROM inventory WHERE user_id = ? ORDER BY price DESC LIMIT 1`, [userId]))[0] || null;
    const inv = await list(userId, { status: 'owned', limit: 1000 });
    return {
      // Current profile bundle names.
      totalCases: opened, totalBattles: battles, totalUpgrades: upgrades,
      bestDropItemName: best?.name || null,
      bestDropItemPrice: best ? Number(best.price) : null,
      bestDropItemImage: best ? fixImageUrl(best.image) : null,
      // Backward-compatible aliases used by older pages/admin adapters.
      openedCases: opened, upgrades,
      wonAmount: Math.round(won),
      inventoryCount: inv.count, inventoryValue: Math.round(inv.totalValue),
      bestDrop: best ? { name: best.name, price: best.price, image: fixImageUrl(best.image), rarity: best.rarity } : null
    };
  }

  /** Persisted game ledger in the exact shape consumed by ProfilePage. */
  async function gameHistory(userId, input = {}) {
    await ensureSchema();
    const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(input.limit, 10) || 20));
    const type = String(input.type || 'all').toLowerCase();
    const definitions = {
      case: { stake: 'case_open', win: 'case_win', source: 'case' },
      upgrader: { stake: 'upgrade', win: 'upgrade_win', source: 'upgrade' },
      battle: { stake: 'battle_entry', win: 'battle_win', source: 'battle' }
    };
    const selected = type === 'all' ? Object.entries(definitions) : [[type, definitions[type]]];
    if (!selected[0]?.[1]) throw Object.assign(new Error('Неизвестный тип истории'), { status: 400 });

    const ledgerTypes = selected.flatMap(([, value]) => [value.stake, value.win]);
    const placeholders = ledgerTypes.map(() => '?').join(',');
    const ledger = await queryAdminDb(
      `SELECT id,type,amount,comment,created_at FROM transactions
       WHERE user_id = ? AND type IN (${placeholders}) ORDER BY id ASC`,
      [userId, ...ledgerTypes]);
    if (ledger.failed) throw new Error('История игр временно недоступна');
    const inventoryRows = await queryAdminDb(
      `SELECT id,item_id,name,image,price,source,source_ref,created_at FROM inventory
       WHERE user_id = ? AND source IN (${selected.map(() => '?').join(',')}) ORDER BY id ASC`,
      [String(userId), ...selected.map(([, value]) => value.source)]);
    if (inventoryRows.failed) throw new Error('История выигрышей временно недоступна');

    const entries = [];
    const consumedInventoryIds = new Set();
    for (const [gameType, definition] of selected) {
      const stakes = ledger.filter(row => row.type === definition.stake);
      for (let index = 0; index < stakes.length; index++) {
        const row = stakes[index];
        const nextId = stakes[index + 1]?.id ?? Number.POSITIVE_INFINITY;
        const sameMoment = value => String(value.created_at) === String(row.created_at);
        const wins = ledger.filter(value => value.type === definition.win &&
          value.id > row.id && value.id < nextId);
        const expectedItems = Math.max(1, Number(String(row.comment || '').match(/\bx(\d+)\s*$/i)?.[1]) || 1);
        const sourceRef = String(row.comment || '').match(/^Открытие:\s*(.*?)\s+x\d+\s*$/i)?.[1];
        const wonItems = inventoryRows.filter(value => value.source === definition.source && sameMoment(value) &&
          !consumedInventoryIds.has(value.id) && (!sourceRef || String(value.source_ref || '') === sourceRef)).slice(0, expectedItems);
        wonItems.forEach(value => consumedInventoryIds.add(value.id));
        const betAmount = Math.abs(Number(row.amount) || 0);
        const winAmount = gameType === 'case'
          ? wonItems.reduce((sum, value) => sum + (Number(value.price) || 0), 0)
          : wins.reduce((sum, value) => sum + Math.max(0, Number(value.amount) || 0), 0);
        const rawDate = String(row.created_at || '');
        const timestamp = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(rawDate) ? rawDate : `${rawDate.replace(' ', 'T')}Z`);
        entries.push({
          id: `${gameType}-${row.id}`,
          createdAt: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0,
          betAmount,
          winAmount,
          multiplier: betAmount > 0 ? Number((winAmount / betAmount).toFixed(4)) : 0,
          itemsWon: wonItems.map(value => ({ itemId: value.item_id ?? value.id, name: value.name, image: fixImageUrl(value.image) })),
          isWin: winAmount > 0,
          isFree: betAmount === 0
        });
      }
    }
    entries.sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
    return { items: entries.slice((page - 1) * limit, page * limit), total: entries.length, page, limit };
  }

  return {
    ensureSchema, award, settleCase, list, sell, sellAll,
    requestWithdraw, listWithdrawals, cancelWithdraw, userStats, gameHistory,
    AUTO_SELL, TRADE_LINK_RE
  };
}

module.exports = { makeInventoryService };
