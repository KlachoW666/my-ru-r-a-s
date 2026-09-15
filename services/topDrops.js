'use strict';

// Общий источник для суточного топа и live-ленты — только сохранённые игры.
// 03:00 МСК = 00:00 UTC; локальная зона времени сервера не участвует.
function makeTopDropsService({queryAdminDb,fixImageUrl=x=>x,mapRarity=x=>x,now=Date.now}) {
 const modes=new Set(['cases','upgrader','battles']);
 async function query(sql,args=[]){
  const rows=await queryAdminDb(sql,args);
  if(!Array.isArray(rows)||rows.failed)throw new Error('Результаты игр временно недоступны');
  return rows;
 }
 async function events(mode){
  if(!modes.has(mode))throw Object.assign(new Error('Неизвестный режим'),{status:400});
  const dayUtc=new Date(now()).toISOString().slice(0,10);
  const tables=new Set((await query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>r.name));
  const has=(...names)=>names.every(n=>tables.has(n));
  const userColumns=has('users')?new Set((await query('PRAGMA table_info(users)')).map(r=>r.name)):new Set();
  const privacyColumns=['hiddenFromPublicTops','hidden_from_public_tops'].filter(c=>userColumns.has(c));
  const hiddenUserIds=new Set(privacyColumns.length?(await query(`SELECT id FROM users WHERE ${privacyColumns.map(c=>`COALESCE(${c},0)<>0`).join(' OR ')}`)).map(r=>String(r.id)):[]);
  let rows=[];
  if(mode==='cases'&&has('inventory','users','cases','transactions')){
   rows=await query(`SELECT i.id,i.user_id,u.username,u.avatar,i.name,i.image,i.price,i.rarity,
     i.created_at,c.slug,c.name case_name,c.image case_image,c.archived,
     COALESCE(t.amount,0) stake_total,t.comment stake_comment
     FROM inventory i JOIN users u ON u.id=i.user_id
     LEFT JOIN cases c ON c.slug=i.source_ref
     LEFT JOIN transactions t ON t.id=(SELECT id FROM transactions
       WHERE user_id=i.user_id AND type='case_open'
       AND datetime(created_at)=datetime(i.created_at)
       AND comment LIKE 'Открытие: '||i.source_ref||' x%'
       ORDER BY id DESC LIMIT 1)
     WHERE i.source='case' AND datetime(i.created_at)>=datetime(?)
       AND datetime(i.created_at)<datetime(?,'+1 day')`,[dayUtc,dayUtc]);
   rows=rows.map(r=>({...r,stake:Math.abs(Number(r.stake_total))/Math.max(1,Number(r.stake_comment?.match(/x(\d+)\s*$/)?.[1])||1)}));
  }else if(mode==='upgrader'&&has('transactions','users','items')){
   rows=await query(`SELECT w.id,w.user_id,u.username,u.avatar,w.comment name,w.amount price,w.created_at,
     i.image,i.rarity,ABS(s.amount) stake FROM transactions w JOIN users u ON u.id=w.user_id
     LEFT JOIN items i ON i.id=(SELECT id FROM items WHERE name=w.comment ORDER BY id LIMIT 1)
     JOIN transactions s ON s.id=(SELECT id FROM transactions WHERE user_id=w.user_id AND type='upgrade' AND id<w.id ORDER BY id DESC LIMIT 1)
     WHERE w.type='upgrade_win' AND w.amount>0 AND datetime(w.created_at)>=datetime(?)
       AND datetime(w.created_at)<datetime(?,'+1 day')`,[dayUtc,dayUtc]);
  }else if(mode==='battles'&&has('transactions','users')){
   const wins=await query(`SELECT w.id,w.user_id,u.username,u.avatar,w.comment,w.amount price,w.created_at
     FROM transactions w JOIN users u ON u.id=w.user_id WHERE w.type='battle_win' AND w.amount>0
     AND datetime(w.created_at)>=datetime(?) AND datetime(w.created_at)<datetime(?,'+1 day')`,[dayUtc,dayUtc]);
   const cases=has('battles')?new Map((await query("SELECT * FROM battles WHERE status='finished' AND COALESCE(is_private,0)=0")).map(b=>[b.uid,b])):new Map();
   const upgrades=has('upgrade_battles')?new Map((await query("SELECT uid,round_bet_cents FROM upgrade_battles WHERE status='finished'")).map(b=>[b.uid,b])):new Map();
   for(const w of wins){
    const uid=w.comment?.replace(/^(Кейс-батл|Апгрейд-батл) /,'');
    const b=w.comment?.startsWith('Кейс-батл ')?cases.get(uid):upgrades.get(uid);
    if(!b)continue;
    rows.push({...w,battle_uid:uid,stake:b.total_price??b.round_bet_cents*3/100,players:b.max_players??2,rounds:b.rounds??3});
   }
  }
  const entries=rows.filter(r=>!hiddenUserIds.has(String(r.user_id))).map(r=>{
   const price=Number(r.price)||0,stake=Number(r.stake)||0,mult=stake>0?price/stake:0;
   return {entryId:`${mode}-${r.id}`,userId:Number(r.user_id),displayName:r.username||'Игрок',
    avatarUrl:fixImageUrl(r.avatar),itemName:r.name||'Победа в батле',itemImage:fixImageUrl(r.image),itemRarity:mapRarity(r.rarity),
    metricDisplay:(mode==='battles'?price:mult).toFixed(2),prizeValue:price.toFixed(2),stakeValue:stake.toFixed(2),
    caseSlug:r.slug||'',caseName:r.case_name||'',caseImage:fixImageUrl(r.case_image),caseAvailable:!!r.slug&&!r.archived,
    battleId:r.battle_uid,playersCount:r.players||0,roundsAmount:r.rounds||0,targetMultiplier:mult.toFixed(2),
    wonAt:Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(r.created_at)?r.created_at:r.created_at.replace(' ','T')+'Z')/1000),
    metric:mode==='battles'?price:mult};
  });
  return {dayUtc,entries,hiddenUserIds};
 }
 async function ranked(mode){
  const result=await events(mode),seen=new Set();
  result.entries.sort((a,b)=>b.metric-a.metric||Number(b.prizeValue)-Number(a.prizeValue)||a.wonAt-b.wonAt||a.entryId.localeCompare(b.entryId));
  result.entries=result.entries.filter(e=>!seen.has(e.userId)&&seen.add(e.userId)).map((e,i)=>({...e,rank:i+1}));
  return result;
 }
 async function board(mode){const r=await ranked(mode);return {dayUtc:r.dayUtc,entries:r.entries.slice(0,10),version:now()};}
 async function me(mode,userId){const r=await ranked(mode),entry=r.entries.find(e=>String(e.userId)===String(userId))||null;return {hasEntry:!!entry,entry,rank:entry?.rank||0,hiddenFromPublicTops:r.hiddenUserIds.has(String(userId))};}
 async function recent(mode,limit){
  const all=(await Promise.all([...modes].map(async m=>(await events(m)).entries.map(e=>({...e,mode:m}))))).flat();
  all.sort(mode==='top'||mode==='bigwins'?(a,b)=>Number(b.prizeValue)-Number(a.prizeValue):(a,b)=>b.wonAt-a.wonAt||b.entryId.localeCompare(a.entryId,undefined,{numeric:true}));
  return all.slice(0,limit).map(e=>({sourceEventId:e.entryId,userId:e.userId,userName:e.displayName,avatarUrl:e.avatarUrl,steamLevel:0,wonAt:e.wonAt,
   eventType:{cases:'CASE',upgrader:'UPGRADER',battles:'BATTLE'}[e.mode],gameType:{cases:'case',upgrader:'upgrader',battles:'cratebattle'}[e.mode],
   itemName:e.itemName,itemImage:e.itemImage,itemValue:Number(e.prizeValue),betAmount:Number(e.stakeValue),winAmount:Number(e.prizeValue),
   multiplier:e.metric,isBigWin:Number(e.prizeValue)>=5000,caseSlug:e.caseSlug,caseName:e.caseName,caseImage:e.caseImage,battleId:e.battleId,itemRarity:e.itemRarity}));
 }
 return {board,me,recent};
}
function registerTopDropsRoutes(app,{service,requireUser}){
 app.get('/api/v1/topdrops',async(req,res)=>{try{res.json({status:'success',data:await service.board(req.query.mode||'cases')});}catch(e){res.status(e.status||503).json({status:'error',message:e.message});}});
 app.get('/api/v1/topdrops/me',async(req,res)=>{try{const user=await requireUser(req,res);if(!user)return;res.json({status:'success',data:await service.me(req.query.mode||'cases',user.id)});}catch(e){res.status(e.status||503).json({status:'error',message:e.status?e.message:'Результаты игр временно недоступны'});}});
 app.post('/api/v1/topdrops/click',(_req,res)=>res.json({status:'success',data:{recorded:false}}));
}
module.exports={makeTopDropsService,registerTopDropsRoutes};
