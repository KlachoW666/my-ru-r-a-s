'use strict';

const sqlite = require('sqlite3');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { buildDistribution, DEFAULT_RTP } = require('../../services/drops');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const codeFor = rtp => `rtp_${Number(rtp)}`;
const number = (value, name, min, max) => {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max) fail(400, `Некорректное поле ${name}`);
  return n;
};
const list = value => value == null ? [] : (Array.isArray(value) ? value : String(value).split(','));

function register({ app, DB_PATH, requireAdminJWT }) {
  const jobs = new Map();
  let schemaReady;
  function connect() {
    const db = new sqlite.Database(DB_PATH); db.configure('busyTimeout',5000);
    return {
      all: (s,p=[]) => new Promise((ok,no)=>db.all(s,p,(e,r)=>e?no(e):ok(r))),
      run: (s,p=[]) => new Promise((ok,no)=>db.run(s,p,function(e){e?no(e):ok({changes:this.changes,lastID:this.lastID});})),
      close: () => new Promise(resolve=>db.close(resolve))
    };
  }
  async function schema(db) {
    if (!schemaReady) schemaReady = (async()=>{
      await db.run('CREATE TABLE IF NOT EXISTS game_descriptions (game_id TEXT PRIMARY KEY, description TEXT NOT NULL)');
      await db.run(`CREATE TABLE IF NOT EXISTS rtp_assignment_audit (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, old_code TEXT, new_code TEXT,
        changed_by TEXT, reason TEXT, changed_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    })().catch(e=>{schemaReady=undefined;throw e;});
    await schemaReady;
  }
  function route(method,path,fn,write=false) {
    app[method]('/api/v1/admin'+path,requireAdminJWT,async(req,res)=>{
      const db=connect(); let transaction=false;
      try {
        await schema(db);
        if(write){await db.run('BEGIN IMMEDIATE');transaction=true;}
        const data=await fn(req,db);
        if(transaction){await db.run('COMMIT');transaction=false;}
        res.json({success:true,data});
      } catch(e) {
        if(transaction) await db.run('ROLLBACK').catch(()=>{});
        res.status(e.status||500).json({success:false,message:e.message});
      } finally { await db.close(); }
    });
  }
  async function games(db) {
    const rows=await db.all(`SELECT g.*,d.description FROM game_configs g LEFT JOIN game_descriptions d ON d.game_id=g.id ORDER BY g.rowid`);
    const [counts]=await db.all(`SELECT SUM(CASE WHEN isActive=1 AND status='active' AND archived=0 THEN 1 ELSE 0 END) AS active,COUNT(*) AS total FROM cases`);
    return {modes:rows.map(r=>({name:r.id,description:r.description??r.name??'',enabled:r.enabled===1})),
      caseStates:{totalActive:counts.active||0,totalInactive:(counts.total||0)-(counts.active||0)}};
  }
  route('get','/config/games',(_,db)=>games(db));
  route('put','/config/games/:name',async(req,db)=>{
    const b=req.body||{};
    if(typeof b.enabled!=='boolean')fail(400,'enabled должен быть true или false');
    if(b.description!==undefined&&(typeof b.description!=='string'||b.description.length>2000))fail(400,'Некорректное описание');
    const r=await db.run('UPDATE game_configs SET enabled=? WHERE id=?',[Number(b.enabled),req.params.name]);
    if(!r.changes)fail(404,'Режим не найден');
    if(b.description!==undefined)await db.run(`INSERT INTO game_descriptions VALUES(?,?) ON CONFLICT(game_id) DO UPDATE SET description=excluded.description`,[req.params.name,b.description.trim()]);
    return games(db);
  },true);

  route('get','/battles',async(req,db)=>{
    const statusMap={PENDING:'waiting',ACTIVE:'running',FINISHING:'finishing',RESOLVED:'finished'};
    const page=number(req.query.page??1,'page',1,1000000),limit=number(req.query.limit??20,'limit',1,500);
    if(!Number.isInteger(page)||!Number.isInteger(limit))fail(400,'Пагинация должна быть целочисленной');
    const where=req.query.status?' WHERE b.status=?':'',params=[];
    if(req.query.status){if(!statusMap[req.query.status])fail(400,'Неизвестный статус батла');params.push(statusMap[req.query.status]);}
    const [count]=await db.all('SELECT COUNT(*) AS total FROM battles b'+where,params);
    const rows=await db.all(`SELECT b.*, (SELECT COUNT(*) FROM battle_players p WHERE p.battle_id=b.id) AS participants
      FROM battles b${where} ORDER BY b.created_at DESC,b.id DESC LIMIT ? OFFSET ?`,[...params,limit,(page-1)*limit]);
    return {items:rows.map(r=>({battleId:r.uid,status:Object.keys(statusMap).find(k=>statusMap[k]===r.status)||r.status,
      mode:'Стандартный',slots:r.max_players,participantCount:r.participants,totalPot:r.total_price*r.participants,
      createdBy:r.creator_id,createdAt:r.created_at?new Date(r.created_at.includes('T')?r.created_at:r.created_at.replace(' ','T')+'Z').toISOString():null})),pagination:{page,limit,total:count.total}};
  });

  async function tiers(db) {
    const rows=await db.all(`SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.rtp=t.rtp) AS user_count FROM rtp_tiers t ORDER BY t.priority,t.id`);
    const seen=new Set();
    return rows.filter(r=>{const c=codeFor(r.rtp);if(seen.has(c))return false;seen.add(c);return true;}).map(r=>({
      id:r.id,code:codeFor(r.rtp),label:r.name,targetRtp:Number(r.rtp)/100,isDefault:Number(r.rtp)===DEFAULT_RTP,
      isActive:r.active===1,sortOrder:r.priority,assignedUserCount:r.user_count
    }));
  }
  route('get','/rtp/tiers',(_,db)=>tiers(db));
  async function assign(req,db,entries) {
    if(!Array.isArray(entries)||entries.length<1||entries.length>5000)fail(400,'Нужно от 1 до 5000 назначений');
    const available=await tiers(db), result={appliedCount:0,skippedCount:0,errors:[]};
    for(let i=0;i<entries.length;i++) {
      const entry=entries[i]||{}, uid=String(entry.userId??''), tier=available.find(t=>t.code===entry.targetCode&&t.isActive);
      const [user]=await db.all('SELECT id,rtp FROM users WHERE CAST(id AS TEXT)=?',[uid]);
      if(!tier||!user){result.errors.push({lineNumber:i+1,userId:uid,targetCode:entry.targetCode,error:!tier?'Тир не найден или неактивен':'Пользователь не найден'});continue;}
      if(Number(user.rtp)===tier.targetRtp*100){result.skippedCount++;continue;}
      await db.run(`INSERT INTO rtp_assignments(user_id,tier_id,rtp_override,assigned_by) VALUES(?,?,NULL,?)
        ON CONFLICT(user_id) DO UPDATE SET tier_id=excluded.tier_id,rtp_override=NULL,assigned_by=excluded.assigned_by,assigned_at=CURRENT_TIMESTAMP`,[uid,tier.id,String(req.user?.userId??req.user?.id??req.user?.username??'admin')]);
      await db.run('UPDATE users SET rtp=? WHERE id=?',[Math.round(tier.targetRtp*10000)/100,user.id]);
      await db.run('INSERT INTO rtp_assignment_audit(user_id,old_code,new_code,changed_by,reason) VALUES(?,?,?,?,?)',
        [uid,codeFor(user.rtp),tier.code,String(req.user?.username??req.user?.userId??req.user?.id??'admin'),String(req.body.reason||req.body.sourceLabel||'bulk-import').slice(0,500)]);
      result.appliedCount++;
    }
    return result;
  }
  route('post','/rtp/users/bulk',(req,db)=>assign(req,db,req.body?.assignments),true);
  async function userTier(req,db){
    const [user]=await db.all('SELECT id,rtp FROM users WHERE CAST(id AS TEXT)=?',[req.params.id]);
    if(!user)fail(404,'Пользователь не найден');
    const tier=(await tiers(db)).find(t=>t.code===codeFor(user.rtp))||{
      code:codeFor(user.rtp),label:'Индивидуальный RTP',targetRtp:Number(user.rtp)/100,isDefault:false,isActive:true
    };
    return {userId:String(user.id),tier};
  }
  route('get','/rtp/users/:id/tier',userTier);
  route('get','/rtp/users/:id/tier/audit',async(req,db)=>{
    await userTier(req,db);
    const rows=await db.all('SELECT * FROM rtp_assignment_audit WHERE user_id=? ORDER BY id DESC LIMIT 200',[req.params.id]);
    return rows.map(r=>({traceId:String(r.id),changedAt:r.changed_at.replace(' ','T')+'Z',changedBy:r.changed_by,
      oldTierCode:r.old_code,newTierCode:r.new_code,reason:r.reason}));
  });
  async function changeTier(req,db,reset){
    await userTier(req,db);
    if(typeof req.body?.reason!=='string'||!req.body.reason.trim()||req.body.reason.length>500)fail(400,'Укажите причину изменения (до 500 символов)');
    const targetCode=reset?codeFor(DEFAULT_RTP):req.body.targetCode;
    const result=await assign(req,db,[{userId:req.params.id,targetCode}]);
    if(result.errors.length)fail(400,result.errors[0].error);
    return userTier(req,db);
  }
  route('put','/rtp/users/:id/tier',(req,db)=>changeTier(req,db,false),true);
  route('post','/rtp/users/:id/tier/reset',(req,db)=>changeTier(req,db,true),true);

  route('get','/rtp/stats',async(req,db)=>{
    const clauses=[`type IN ('case_open','case_win','upgrade','upgrade_win','battle_entry','battle_win')`], args=[];
    for(const [key,operator] of [['from','>='],['to','<']]) if(req.query[key]){
      const value=Date.parse(req.query[key]);if(!Number.isFinite(value))fail(400,'Некорректная дата '+key);
      clauses.push(`julianday(created_at) ${operator} julianday(?)`);args.push(new Date(value).toISOString());
    }
    if(req.query.from&&req.query.to&&Date.parse(req.query.from)>=Date.parse(req.query.to))fail(400,'Начало периода должно быть раньше конца');
    const selectedTiers=list(req.query.tiers??req.query['tiers[]']);
    // Historical ledger does not record the tier at play time. Never relabel it
    // with today's user assignment: that would rewrite history after every CSV.
    if(selectedTiers.length&&!selectedTiers.includes('legacy_unknown'))return [];
    const selected=list(req.query.mechanics??req.query['mechanics[]']);
    const mapping={case_open:'CASE_OPENING',case_win:'CASE_OPENING',upgrade:'UPGRADER',upgrade_win:'UPGRADER',battle_entry:'CRATE_BATTLE',battle_win:'CRATE_BATTLE'};
    if(selected.some(x=>!Object.values(mapping).includes(x)))fail(400,'Неизвестная механика');
    const rows=await db.all(`SELECT type,COUNT(*) AS count,COALESCE(SUM(ABS(amount)),0) AS amount FROM transactions WHERE ${clauses.join(' AND ')} GROUP BY type`,args);
    const groups=new Map();
    for(const row of rows){
      const mechanic=mapping[row.type];if(selected.length&&!selected.includes(mechanic))continue;
      if(!groups.has(mechanic))groups.set(mechanic,{tierCode:'legacy_unknown',mechanic,betCount:0,totalWager:0,totalPayout:0});
      const g=groups.get(mechanic);
      if(row.type.endsWith('_win'))g.totalPayout+=row.amount;else{g.totalWager+=row.amount;g.betCount+=row.count;}
    }
    return [...groups.values()].map(g=>({...g,totalWager:String(g.totalWager),totalPayout:String(g.totalPayout),actualRtp:String(g.totalWager?g.totalPayout/g.totalWager:0)}));
  });

  const owner=req=>String(req.user?.userId??req.user?.id??req.user?.username??'admin');
  const publicJob=job=>({id:job.id,type:job.type,status:job.status,progress:job.progress,result:job.result,error:job.error});
  const findJob=req=>{const job=jobs.get(req.params.id);if(!job||job.owner!==owner(req))fail(404,'Задача не найдена или срок хранения истёк');return job;};
  route('get','/rtp/jobs/:id',req=>publicJob(findJob(req)));
  route('delete','/rtp/jobs/:id',async req=>{
    const job=findJob(req);
    if(job.status==='running'){job.status='error';job.error='Задача отменена';await job.worker.terminate();}
    return publicJob(job);
  });
  route('post','/rtp/validate',async(req,db)=>{
    const b=req.body||{}, mechanic=b.mechanic;
    if(!['CASE_OPENING','UPGRADER','CRATE_BATTLE'].includes(mechanic))fail(400,'Неизвестная механика');
    const iterations=number(b.iterations,'iterations',1000,mechanic==='CASE_OPENING'?100000000:30000000);
    if(!Number.isSafeInteger(iterations))fail(400,'iterations должно быть целым');
    const tier=(await tiers(db)).find(t=>t.code===b.tier&&t.isActive);
    if(!tier)fail(400,'Выберите существующий активный RTP-тир');
    const nonceStart=number(b.nonceStart??0,'nonceStart',0,Number.MAX_SAFE_INTEGER-1000000000);
    if(!Number.isSafeInteger(nonceStart))fail(400,'nonceStart должно быть целым');
    if(mechanic==='CRATE_BATTLE')fail(409,'Валидация победителя батла пока не подключена. Проверка отдельных кейсов доступна в CASE_OPENING.');
    let entries,casePrice;
    if(mechanic==='CASE_OPENING'){
      const [c]=await db.all('SELECT * FROM cases WHERE CAST(id AS TEXT)=?',[String(b.caseId??'')]);
      if(!c)fail(404,'Кейс не найден');
      const items=await db.all(`SELECT i.*,ci.chance,ci.ticketRangeFrom,ci.ticketRangeTo FROM case_items ci JOIN items i ON i.id=ci.item_id WHERE ci.case_id=? AND COALESCE(i.delisted,0)=0 AND COALESCE(i.admin_disabled,0)=0`,[c.id]);
      if(!items.length)fail(409,'У кейса отсутствует доступный состав. Добавьте предметы и шансы в разделе «Кейсы».');
      casePrice=number(c.price,'casePrice',.01,1e12);
      entries=buildDistribution(items,{casePrice,rtp:tier.targetRtp*100}).entries;
      if(entries.some(e=>!Number.isFinite(e.p)||e.p<0||!Number.isFinite(Number(e.item.price))))fail(409,'Некорректные шансы или цены в составе кейса');
    }else{
      const bet=b.targetMultiplier?1:number(b.bet,'bet',1,1e12);
      const target=b.targetMultiplier?number(b.targetMultiplier,'targetMultiplier',1.01,100):number(b.totalItemsValue,'totalItemsValue',.01,1e14);
      const mult=target/bet;if(mult<1.01||mult>100)fail(400,'Множитель должен быть от 1.01 до 100');
      casePrice=bet;
      // Mirror the live upgrader: it currently uses the global setting, not user.rtp.
      const chance=Math.min(.95,Math.max(.01,bet/target*Number(process.env.UPGRADER_RTP||.95)));
      entries=[{item:{price:Math.round(target)},p:chance},{item:{price:0},p:1-chance}];
    }
    for(const [id,job] of jobs)if(job.status!=='running'&&Date.now()-job.createdAt>3600000)jobs.delete(id);
    if([...jobs.values()].filter(j=>j.status==='running').length>=2)fail(429,'Уже выполняются две проверки. Дождитесь завершения или отмените одну.');
    while(jobs.size>=32){const old=[...jobs.values()].find(j=>j.status!=='running');if(!old)break;jobs.delete(old.id);}
    const seedServer=String(b.seedServer||crypto.randomBytes(32).toString('hex')),seedClient=String(b.seedClient||crypto.randomBytes(16).toString('hex'));
    if(seedServer.length>1024||seedClient.length>1024)fail(400,'Сид слишком длинный');
    const id=crypto.randomUUID(), job={id,type:'rtp-validate',status:'running',owner:owner(req),createdAt:Date.now(),progress:{type:'progress',iterationsDone:0,currentEmpRtp:0,currentCi95:0}};
    const worker=new Worker(require.resolve('./rtpValidationWorker'),{workerData:{entries,casePrice,iterations,seedServer,seedClient,nonceStart,targetRtp:tier.targetRtp}});
    job.worker=worker;jobs.set(id,job);
    worker.on('message',message=>{if(job.status!=='running')return;if(message.type==='done'){job.status='done';job.result=message.result;}else job.progress=message;});
    worker.on('error',e=>{job.status='error';job.error=e.message;});
    worker.on('exit',code=>{if(job.status==='running'){job.status='error';job.error=`Задача завершилась без результата (${code})`;}delete job.worker;});
    return {jobId:id};
  });
}
module.exports={register};
