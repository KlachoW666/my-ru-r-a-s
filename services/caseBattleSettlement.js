'use strict';

const crypto = require('node:crypto');
const {transaction} = require('./sqliteTransaction');
const {buildDistribution, rollOne, newServerSeed, DEFAULT_RTP} = require('./drops');
const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}); };
function cents(value) {
  const n = Number(value), c = Math.round(n * 100);
  if (value == null || !Number.isFinite(n) || n < 0 || !Number.isSafeInteger(c) || Math.abs(n * 100 - c) > 0.0001)
    fail(400, 'INVALID_AMOUNT', 'Некорректная денежная сумма');
  return c;
}
function requestKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value))
    fail(400, 'REQUEST_ID_REQUIRED', 'Нужен уникальный requestId (16–100 символов)');
  return value;
}
async function one(db, sql, args) {
  const r = await db.run(sql, args);
  if (r.changes !== 1) fail(503, 'WRITE_FAILED', 'Не удалось сохранить операцию батла');
  return r;
}
function makeCaseBattleSettlement({getAdminDb, ensureSchema, fixImageUrl, botNames, botAvatar}) {
  async function schema(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS case_battle_operations(
      actor_id TEXT NOT NULL,kind TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
      battle_uid TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(actor_id,kind,request_id))`);
    await db.run(`CREATE TABLE IF NOT EXISTS case_battle_settlements(
      battle_id INTEGER PRIMARY KEY,result_json TEXT NOT NULL)`);
    await db.run(`CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  }
  async function account(db, user) {
    if (!user || user.isGuest || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0)
      fail(401, 'UNAUTHORIZED', 'Нужна авторизация');
    const row = await db.get('SELECT * FROM users WHERE id=?', [user.id]);
    if (!row) fail(401, 'UNAUTHORIZED', 'Пользователь не найден');
    if (row.status && row.status !== 'active') fail(403, 'FORBIDDEN', 'Пользователь неактивен');
    cents(row.balance);
    return row;
  }
  async function ledger(db, id, type, value, uid) {
    await one(db, 'INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',
      [id, type, value / 100, `Кейс-батл ${uid}`]);
  }
  async function debit(db, id, value, uid) {
    const r = await db.run('UPDATE users SET balance=ROUND(balance-?,2) WHERE id=? AND ROUND(balance*100)>=?',
      [value / 100, id, value]);
    if (r.changes !== 1) fail(400, 'INSUFFICIENT_BALANCE', 'Недостаточно средств');
    await ledger(db, id, 'battle_entry', -value, uid);
  }
  async function previous(db, id, kind, key, fingerprint) {
    const r = await db.get('SELECT * FROM case_battle_operations WHERE actor_id=? AND kind=? AND request_id=?', [String(id), kind, key]);
    if (!r) return null;
    if (r.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'Данные повторного запроса изменились');
    return {...JSON.parse(r.response_json), replayed: true};
  }
  async function receipt(db, id, kind, key, fingerprint, result) {
    await one(db, 'INSERT INTO case_battle_operations VALUES(?,?,?,?,?,?)',
      [String(id), kind, key, fingerprint, result.uid, JSON.stringify(result)]);
    return result;
  }
  async function catalog(db, slugs) {
    const result = [];
    for (const slug of slugs) {
      const row = await db.get('SELECT * FROM cases WHERE slug=? OR id=?', [slug, slug]);
      if (!row) fail(400, 'NO_CASES', `Кейс не найден: ${slug}`);
      cents(row.price);
      const items = await db.all(`SELECT ci.*,i.name,i.price,i.image,i.rarity FROM case_items ci
        JOIN items i ON ci.item_id=i.id WHERE ci.case_id=? ORDER BY ci.id`, [row.id]);
      if (!items.length) fail(409, 'EMPTY_CASE', `Кейс пуст: ${slug}`);
      result.push({row, items: items.map(i => ({...i, id:i.item_id, price:cents(i.price)/100,
        image:fixImageUrl(i.image), chance:Number(i.chance)||0,
        ticketRangeFrom:Number(i.ticketRangeFrom)||0, ticketRangeTo:Number(i.ticketRangeTo)||0}))});
    }
    return result;
  }
  async function settle(db, b, players) {
    const cases = await catalog(db, JSON.parse(b.case_slugs));
    const totals = new Map(players.map(p => [p.slot, 0]));
    await one(db, "UPDATE battles SET status='running' WHERE id=? AND status='waiting'", [b.id]);
    for (let round=0; round<b.rounds; round++) for (const c of cases) {
      // Keep the legacy distribution and seed/nonce convention for case battles.
      const dist = buildDistribution(c.items, {casePrice:c.row.price || 49, rtp:DEFAULT_RTP});
      if (!dist.entries.length) fail(409, 'EMPTY_CASE', 'Не удалось рассчитать кейс');
      for (const p of players) {
        const {item} = rollOne(dist, {serverSeed:b.server_seed, clientSeed:`${b.uid}:${c.row.slug}`, nonce:round*100+p.slot});
        if (!item) fail(503, 'ROLL_FAILED', 'Не удалось рассчитать результат');
        const value = cents(item.price);
        totals.set(p.slot, totals.get(p.slot)+value);
        await one(db, `INSERT INTO battle_drops(battle_id,round,slot,item_name,item_image,item_price,item_rarity)
          VALUES(?,?,?,?,?,?,?)`, [b.id,round,p.slot,item.name,fixImageUrl(item.image),value/100,item.rarity]);
      }
    }
    const best = Math.max(...totals.values()), winners = players.filter(p=>totals.get(p.slot)===best);
    // Legacy economy: entry price * ALL slots, including uncharged bots.
    // Bot winner shares stay with the house; never credit a fictitious account.
    const pot = cents(b.total_price) * players.length;
    if (!Number.isSafeInteger(pot)) fail(400, 'INVALID_AMOUNT', 'Слишком большой банк');
    const payouts = winners.map((p,i)=>({...p, shareCents:Math.floor(pot/winners.length)+(i<pot%winners.length?1:0)}));
    for (const p of players) await one(db, 'UPDATE battle_players SET total_value=? WHERE id=?', [totals.get(p.slot)/100,p.id]);
    for (const p of payouts) if (!p.is_bot && p.shareCents) {
      const receiver = await db.get('SELECT balance FROM users WHERE id=?', [p.user_id]);
      if (!receiver) fail(503, 'PAYOUT_FAILED', 'Получатель выплаты не найден');
      cents(receiver.balance);
      await one(db, 'UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?', [p.shareCents/100,p.user_id]);
      await ledger(db, p.user_id, 'battle_win', p.shareCents, b.uid);
    }
    const result = {uid:b.uid, pot:pot/100, totals:Object.fromEntries([...totals].map(([slot,value])=>[slot,value/100])),
      winners:payouts.map(p=>({userId:p.user_id,slot:p.slot,isBot:!!p.is_bot,share:p.shareCents/100}))};
    await one(db, 'INSERT INTO case_battle_settlements VALUES(?,?)', [b.id,JSON.stringify(result)]);
    await one(db, "UPDATE battles SET status='finished',winner_id=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
      [String(winners[0].user_id),b.id]);
    return result;
  }
  async function createPaid({user,caseSlugs,rounds=1,maxPlayers=2,isPrivate=false,requestId}) {
    const key=requestKey(requestId);
    if (!Array.isArray(caseSlugs) || !caseSlugs.length || caseSlugs.length>100 || !caseSlugs.every(s=>typeof s==='string' && s.length>0 && s.length<=200)
      || !Number.isInteger(rounds) || rounds<1 || rounds>10 || ![2,3,4].includes(maxPlayers))
      fail(400,'INVALID_BATTLE','Некорректные параметры батла');
    const fingerprint=JSON.stringify([caseSlugs,rounds,maxPlayers,!!isPrivate]);
    await ensureSchema();
    return transaction(getAdminDb, async db=>{
      await schema(db); const u=await account(db,user);
      const prior=await previous(db,u.id,'create',key,fingerprint); if (prior) return prior;
      const cases=await catalog(db,caseSlugs), priceCents=cases.reduce((sum,c)=>sum+cents(c.row.price),0)*rounds;
      if (!Number.isSafeInteger(priceCents*maxPlayers)) fail(400,'INVALID_AMOUNT','Слишком большой банк');
      const uid=crypto.randomBytes(isPrivate?16:6).toString('hex'), {serverSeed}=newServerSeed();
      const num=(await db.get('SELECT COUNT(*) n FROM battles')).n+1;
      const r=await one(db, `INSERT INTO battles(uid,name,creator_id,creator_name,creator_avatar,max_players,rounds,case_slugs,total_price,status,is_private,server_seed)
        VALUES(?,?,?,?,?,?,?,?,?,'waiting',?,?)`, [uid,`Замес #${num}`,String(u.id),u.username,u.avatar||'',maxPlayers,rounds,JSON.stringify(cases.map(c=>c.row.slug)),priceCents/100,+!!isPrivate,serverSeed]);
      await debit(db,u.id,priceCents,uid);
      await one(db, 'INSERT INTO battle_players(battle_id,slot,user_id,username,avatar,is_bot) VALUES(?,0,?,?,?,0)', [r.lastID,String(u.id),u.username,u.avatar||'']);
      return receipt(db,u.id,'create',key,fingerprint,{uid,battleId:uid,id:r.lastID,price:priceCents/100,isPrivate:!!isPrivate});
    });
  }
  async function joinPaid({uid,user,asBot=false,requestId}) {
    const key=asBot?requestKey(requestId):null;
    await ensureSchema();
    return transaction(getAdminDb, async db=>{
      await schema(db);const u=await account(db,user);
      const b=await db.get('SELECT * FROM battles WHERE uid=?',[uid]);
      if (!b) fail(404,'NOT_FOUND','Батл не найден');
      if (asBot && String(b.creator_id)!==String(u.id)) fail(403,'FORBIDDEN','Только создатель может добавить бота');
      if (asBot) {const prior=await previous(db,u.id,'bot',key,uid);if(prior)return prior;}
      const players=await db.all('SELECT * FROM battle_players WHERE battle_id=? ORDER BY slot',[b.id]);
      if (!asBot && players.some(p=>String(p.user_id)===String(u.id))) {
        const saved=await db.get('SELECT result_json FROM case_battle_settlements WHERE battle_id=?',[b.id]);
        return {ok:true,uid,battleDbId:b.id,full:players.length===b.max_players,replayed:true,result:saved?JSON.parse(saved.result_json):null};
      }
      if (b.status!=='waiting') fail(409,'ALREADY_STARTED','Батл уже начался');
      if (players.length>=b.max_players) fail(409,'FULL','Мест больше нет');
      if (players.some((p,i)=>p.slot!==i)) fail(503,'INVALID_BATTLE','Нарушен порядок слотов');
      const slot=players.length, id=asBot?`bot-${b.id}-${slot}`:String(u.id);
      if (!asBot) await debit(db,u.id,cents(b.total_price),uid);
      await one(db, 'INSERT INTO battle_players(battle_id,slot,user_id,username,avatar,is_bot) VALUES(?,?,?,?,?,?)',
        [b.id,slot,id,asBot?botNames[slot%botNames.length]:u.username,asBot?botAvatar:u.avatar||'',+asBot]);
      const full=slot+1===b.max_players;
      const result=full?await settle(db,b,await db.all('SELECT * FROM battle_players WHERE battle_id=? ORDER BY slot',[b.id])):null;
      const response={ok:true,uid,battleDbId:b.id,full,result,...asBot?{botUserId:id}:{}};
      return asBot?receipt(db,u.id,'bot',key,uid,response):response;
    });
  }
  return {createPaid,joinPaid};
}
module.exports={makeCaseBattleSettlement};
