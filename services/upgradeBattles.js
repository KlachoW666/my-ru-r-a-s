'use strict';
const crypto=require('node:crypto');
const {transaction}=require('./sqliteTransaction');
const DEFAULT_CONFIG={enabled:false,rtp:0.95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900};
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function number(v,min,max,label){
 if(!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max)fail(400,`Некорректное поле: ${label}`);
 return Number(v);
}
function cents(v,label='сумма'){
 const n=number(v,0.01,100000000,label),c=Math.round(n*100);
 if(Math.abs(n*100-c)>0.00001)fail(400,`${label}: не более двух знаков после запятой`);
 return c;
}
function seed(v){if(typeof v!=='string'||!v.trim()||v.length>128)fail(400,'clientSeed: от 1 до 128 символов');return v;}
function configValue(v){
 if(!v||typeof v.enabled!=='boolean')fail(400,'enabled должен быть true или false');
 const r={enabled:v.enabled,rtp:number(v.rtp,0.01,1,'RTP'),minRoundBet:cents(v.minRoundBet)/100,maxRoundBet:cents(v.maxRoundBet)/100,waitSeconds:number(v.waitSeconds,30,86400,'время ожидания')};
 if(r.minRoundBet>r.maxRoundBet||r.maxRoundBet>10000||!Number.isInteger(r.waitSeconds))fail(400,'Некорректные лимиты');return r;
}
// 52-bit uniform value. JSON encoding makes seed boundaries unambiguous.
function roll(serverSeed,uid,clientSeeds,roundIndex,slot){
 return parseInt(crypto.createHmac('sha256',serverSeed).update(JSON.stringify(['upgrade-battle-v1',uid,clientSeeds,roundIndex,slot])).digest('hex').slice(0,13),16)/0x10000000000000;
}
function splitPot(scores,pot){
 const top=Math.max(...scores);const winners=scores.map((s,i)=>s===top?i:-1).filter(i=>i>=0);
 const result=scores.map(()=>0);winners.forEach((i,n)=>{result[i]=Math.floor(pot/winners.length)+(n<pot%winners.length?1:0);});return result;
}
async function ensureSchema(run){
 for(const sql of [
  `CREATE TABLE IF NOT EXISTS upgrade_battles(uid TEXT PRIMARY KEY,creator_id INTEGER NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('waiting','finished','cancelled')),round_bet_cents INTEGER NOT NULL,rtp REAL NOT NULL,targets_json TEXT NOT NULL,server_seed TEXT NOT NULL,server_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,finished_at INTEGER,cancel_reason TEXT,UNIQUE(creator_id,request_id))`,
  `CREATE TABLE IF NOT EXISTS upgrade_battle_players(battle_uid TEXT NOT NULL,user_id INTEGER NOT NULL,slot INTEGER NOT NULL CHECK(slot IN (0,1)),name TEXT NOT NULL,avatar TEXT,client_seed TEXT NOT NULL,score_cents INTEGER NOT NULL DEFAULT 0,payout_cents INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(battle_uid,slot),UNIQUE(battle_uid,user_id))`,
  `CREATE TABLE IF NOT EXISTS upgrade_battle_rounds(battle_uid TEXT NOT NULL,round_index INTEGER NOT NULL,slot INTEGER NOT NULL,roll REAL NOT NULL,won INTEGER NOT NULL,value_cents INTEGER NOT NULL,PRIMARY KEY(battle_uid,round_index,slot))`,
  `CREATE INDEX IF NOT EXISTS idx_upgrade_battles_expiry ON upgrade_battles(status,expires_at)`,
  `CREATE TABLE IF NOT EXISTS upgrade_battle_config_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,config_json TEXT NOT NULL,created_at INTEGER NOT NULL)`
 ])await run(sql);
 await run('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)',['upgrade_battles',JSON.stringify(DEFAULT_CONFIG)]);
}
function makeUpgradeBattles({getDb,now=Date.now}){
 const tx=fn=>transaction(getDb,fn);
 async function config(db){const row=await db.get("SELECT value FROM app_settings WHERE key='upgrade_battles'");if(!row)fail(503,'Сначала обновите схему админки');return configValue(JSON.parse(row.value));}
 async function enabled(db){const c=await config(db);if(!c.enabled)fail(409,'Режим временно выключен');
  const games=await db.get("SELECT value FROM app_settings WHERE key='games'");
  if(games&&JSON.parse(games.value).isMaintenance)fail(409,'На сайте технические работы');return c;
 }
 async function account(db,id){
  if(!Number.isSafeInteger(Number(id))||Number(id)<=0)fail(401,'Нужна авторизация');
  const u=await db.get('SELECT * FROM users WHERE id=?',[id]);if(!u)fail(401,'Пользователь не найден');
  if(u.status!=='active')fail(403,'Пользователь заблокирован или неактивен');return u;
 }
 async function ledger(db,id,type,value,uid){await db.run('INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',[id,type,value/100,`Апгрейд-батл ${uid}`]);}
 async function debit(db,id,value){const r=await db.run('UPDATE users SET balance=ROUND(balance-?,2) WHERE id=? AND ROUND(balance*100)>=?',[value/100,id,value]);if(r.changes!==1)fail(409,'Недостаточно средств');}
 async function credit(db,id,value){if(!value)return;const r=await db.run('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?',[value/100,id]);if(r.changes!==1)fail(409,'Получатель выплаты не найден');}
 async function row(db,uid){const b=await db.get('SELECT * FROM upgrade_battles WHERE uid=?',[uid]);if(!b)fail(404,'Батл не найден');return b;}
 async function dto(db,b,viewer){
  const players=(await db.all('SELECT * FROM upgrade_battle_players WHERE battle_uid=? ORDER BY slot',[b.uid])).map(p=>({userId:p.user_id,name:p.name,avatar:p.avatar,slot:p.slot,clientSeed:p.client_seed,score:p.score_cents/100,payout:p.payout_cents/100}));
  const rounds=(await db.all('SELECT * FROM upgrade_battle_rounds WHERE battle_uid=? ORDER BY round_index,slot',[b.uid])).map(r=>({roundIndex:r.round_index,slot:r.slot,roll:r.roll,won:!!r.won,value:r.value_cents/100}));
  const targets=JSON.parse(b.targets_json).map(t=>({id:t.id,name:t.name,image:t.image,rarity:t.rarity,price:t.priceCents/100,chance:t.chance}));
  const pot=players.reduce((n,p)=>n+Math.round(p.score*100),0)/100;
  const highest=Math.max(...players.map(p=>p.score));
  return {uid:b.uid,status:b.status,roundBet:b.round_bet_cents/100,entryPrice:b.round_bet_cents*3/100,rtp:b.rtp,targets,players,rounds,pot,
   winnerUserIds:b.status==='finished'&&pot>0?players.filter(p=>p.score===highest).map(p=>p.userId):[],
   createdAt:new Date(b.created_at).toISOString(),expiresAt:new Date(b.expires_at).toISOString(),finishedAt:b.finished_at?new Date(b.finished_at).toISOString():null,
   cancelReason:b.cancel_reason,serverHash:b.server_hash,serverSeed:b.status==='waiting'?null:b.server_seed,
   viewerIsCreator:Number(viewer)===b.creator_id,viewerIsPlayer:players.some(p=>p.userId===Number(viewer))};
 }
 async function refund(db,b,reason){
  if(b.status!=='waiting')return;
  await credit(db,b.creator_id,b.round_bet_cents*3);
  await ledger(db,b.creator_id,'battle_hold_return',b.round_bet_cents*3,b.uid);
  await db.run("UPDATE upgrade_battles SET status='cancelled',finished_at=?,cancel_reason=? WHERE uid=?",[now(),reason,b.uid]);
 }
 async function expireIn(db){
  const rooms=await db.all("SELECT * FROM upgrade_battles WHERE status='waiting' AND expires_at<=? LIMIT 100",[now()]);
  for(const b of rooms)await refund(db,b,'Соперник не найден');return rooms.length;
 }
 async function create(userId,input){return tx(async db=>{
  const user=await account(db,userId);const bet=cents(input.roundBet,'ставка за раунд');
  if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId))fail(400,'Нужен requestId длиной 16–100 символов');
  if(!Array.isArray(input.targetIds)||input.targetIds.length!==3||!input.targetIds.every(x=>Number.isSafeInteger(x)&&x>0))fail(400,'Выберите ровно три цели');
  const clientSeed=seed(input.clientSeed);const fingerprint=hash(JSON.stringify([bet,input.targetIds,clientSeed]));
  const previous=await db.get('SELECT * FROM upgrade_battles WHERE creator_id=? AND request_id=?',[userId,input.requestId]);
  if(previous){if(previous.fingerprint!==fingerprint)fail(409,'Данные повторного запроса изменились');return dto(db,previous,userId);}
  const c=await enabled(db);if(bet<c.minRoundBet*100||bet>c.maxRoundBet*100)fail(400,'Ставка вне лимитов режима');
  await expireIn(db);
  const count=await db.get("SELECT COUNT(*) n FROM upgrade_battles WHERE creator_id=? AND status='waiting'",[userId]);if(count.n>=5)fail(409,'Не более пяти ожидающих батлов');
  const targets=[];
  for(const id of input.targetIds){
   const i=await db.get('SELECT * FROM items WHERE id=? AND upgraderEnabled=1',[id]);if(!i)fail(400,'Цель недоступна для апгрейда');
   const priceCents=cents(i.price,'цена предмета');const chance=bet/priceCents*c.rtp;
   // Reject instead of clamping: clamping silently changes the advertised RTP.
   if(priceCents<=bet||chance<0.01||chance>0.95)fail(400,'Цена цели должна быть выше ставки, шанс — от 1% до 95%');
   targets.push({id:i.id,name:i.name,image:i.image,rarity:i.rarity,priceCents,chance});
  }
  const uid=crypto.randomBytes(16).toString('hex'),serverSeed=crypto.randomBytes(32).toString('hex'),created=now();
  await debit(db,userId,bet*3);
  await db.run(`INSERT INTO upgrade_battles(uid,creator_id,request_id,fingerprint,status,round_bet_cents,rtp,targets_json,server_seed,server_hash,created_at,expires_at) VALUES(?,?,?,?,'waiting',?,?,?,?,?,?,?)`,[uid,userId,input.requestId,fingerprint,bet,c.rtp,JSON.stringify(targets),serverSeed,hash(serverSeed),created,created+c.waitSeconds*1000]);
  await db.run('INSERT INTO upgrade_battle_players(battle_uid,user_id,slot,name,avatar,client_seed) VALUES(?,?,0,?,?,?)',[uid,userId,user.username||'Игрок',user.avatar||'',clientSeed]);
  await ledger(db,userId,'battle_hold',-bet*3,uid);
  return dto(db,await row(db,uid),userId);
 });}
 async function join(userId,uid,input){
  // Expiration commits independently, so rejecting an expired join cannot undo its refund.
  await expire();
  return tx(async db=>{
   const user=await account(db,userId);let b=await row(db,uid);
   if(b.creator_id===Number(userId))fail(409,'Нельзя войти в собственный батл');
   const member=await db.get('SELECT * FROM upgrade_battle_players WHERE battle_uid=? AND user_id=?',[uid,userId]);
   if(member&&b.status==='finished')return dto(db,b,userId);
   if(b.status!=='waiting'||b.expires_at<=now())fail(409,'Батл уже закрыт');
   await enabled(db);const clientSeed=seed(input.clientSeed);
   await debit(db,userId,b.round_bet_cents*3);
   await db.run('INSERT INTO upgrade_battle_players(battle_uid,user_id,slot,name,avatar,client_seed) VALUES(?,?,1,?,?,?)',[uid,userId,user.username||'Игрок',user.avatar||'',clientSeed]);
   const players=await db.all('SELECT * FROM upgrade_battle_players WHERE battle_uid=? ORDER BY slot',[uid]);
   // Convert creator's hold into a played bet; these two ledger entries net to zero.
   await ledger(db,b.creator_id,'battle_hold_release',b.round_bet_cents*3,uid);
   for(const p of players)await ledger(db,p.user_id,'battle_entry',-b.round_bet_cents*3,uid);
   const targets=JSON.parse(b.targets_json),scores=[0,0],seeds=players.map(p=>p.client_seed);
   for(let roundIndex=0;roundIndex<3;roundIndex++)for(let slot=0;slot<2;slot++){
    const value=roll(b.server_seed,uid,seeds,roundIndex,slot),won=value<targets[roundIndex].chance,prize=won?targets[roundIndex].priceCents:0;scores[slot]+=prize;
    await db.run('INSERT INTO upgrade_battle_rounds VALUES(?,?,?,?,?,?)',[uid,roundIndex,slot,value,Number(won),prize]);
   }
   const payouts=splitPot(scores,scores[0]+scores[1]);
   for(const p of players){const value=payouts[p.slot];await credit(db,p.user_id,value);if(value)await ledger(db,p.user_id,'battle_win',value,uid);
    await db.run('UPDATE upgrade_battle_players SET score_cents=?,payout_cents=? WHERE battle_uid=? AND slot=?',[scores[p.slot],value,uid,p.slot]);}
   await db.run("UPDATE upgrade_battles SET status='finished',finished_at=? WHERE uid=?",[now(),uid]);
   return dto(db,await row(db,uid),userId);
  });
 }
 const expire=()=>tx(expireIn);
 const get=async(uid,viewer)=>{await expire();return tx(async db=>dto(db,await row(db,uid),viewer));};
 const list=async(viewer,history=false)=>{await expire();return tx(async db=>({config:await config(db),battles:await Promise.all((await db.all(`SELECT * FROM upgrade_battles WHERE status ${history?"!='waiting'":"='waiting'"} ORDER BY created_at DESC LIMIT 100`)).map(b=>dto(db,b,viewer)))}));};
 const cancel=(userId,uid)=>tx(async db=>{const b=await row(db,uid);if(b.creator_id!==Number(userId))fail(403,'Отменить может только создатель');if(b.status==='finished')fail(409,'Батл уже завершён');await refund(db,b,'Отменён создателем');return dto(db,await row(db,uid),userId);});
 const configure=(input,actor)=>tx(async db=>{const c=configValue(input);await db.run("UPDATE app_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key='upgrade_battles'",[JSON.stringify(c)]);await db.run('INSERT INTO upgrade_battle_config_audit(actor,config_json,created_at) VALUES(?,?,?)',[String(actor),JSON.stringify(c),now()]);return c;});
 const items=(q={})=>tx(async db=>{
  const search=String(q.search||'').trim().slice(0,100);const params=[];let where='upgraderEnabled=1 AND price>0';
  if(search){where+=' AND name LIKE ? ESCAPE \'!\'';params.push('%'+search.replace(/[!%_]/g,'!$&')+'%');}
  for(const [key,op] of [['minPrice','>='],['maxPrice','<=']])if(q[key]!=null&&q[key]!==''){where+=` AND price${op}?`;params.push(number(q[key],0,100000000,key));}
  return {items:await db.all(`SELECT id,name,price,image,rarity FROM items WHERE ${where} ORDER BY price ASC,id ASC LIMIT 100`,params),total:(await db.get(`SELECT COUNT(*) n FROM items WHERE ${where}`,params)).n};
 });
 return {create,join,get,list,cancel,expire,configure,items,config:()=>tx(config)};
}
module.exports={makeUpgradeBattles,ensureSchema,roll,splitPot,DEFAULT_CONFIG};
