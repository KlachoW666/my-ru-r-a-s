'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
const { makeBattlesService } = require('../services/battles');
/* test_strategy:
 * artifact: case-battles DTO / compiled consumers
 * rationale: Reproduce zero pot and non-iterable rounds with real SQLite; Gate 0 OFF.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Actual compiled store consumes persisted DTO, not a handwritten substitute.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [temporary SQLite, node vm, compiled JS]
 *     gate: Gate 2 / Gate 3
 *   - rationale: Explicit task requires consumer contract regression despite shared deploy.
 *     type: contract
 *     size: medium
 *     framework: node:test
 *     dependencies: [compiled lobby expressions, compiled battle API client]
 *     gate: Gate 4 override
 * rejected_types:
 *   - reason: Gate 1 covered through real service and consumers.
 *     type: unit
 *   - reason: Smaller integration tests reproduce the deterministic contract failure.
 *     type: e2e
 *   - reason: No authorized production financial smoke; Gate 5 OFF.
 *     type: smoke
 *   - reason: Finite status cases; Gate 6 OFF.
 *     type: property-based
 * deliberately_skipped:
 *   - why: Root server is owned by main; no live DB mutations.
 *     what: Production debit/payout verification
 * AC-1: persisted price reaches the exact lobby sum expression.
 * AC-2: compiled store loads waiting/running/finished; duplicates survive.
 * AC-3: missing catalog/failed writes never become fake success.
 * AC-4: client preserves slots and rejects empty mutation responses.
 * AC-5: creator-slot failures roll back the room; only its creator adds bots.
 * AC-6: one successful last-slot join; add-bot reloads persisted results.
 */
const asset = name => fs.readFileSync(path.join(__dirname, '../public/assets/js', name), 'utf8');
function client(request) {
  const source = asset('battles-CDdvFXfE.js');
  return vm.runInNewContext(source.slice(source.indexOf('const C='), source.indexOf(',M={key:0'))+';C', {
    s: request, e: x => x, f: {}, b: () => undefined,
  });
}
function gameStore(api) {
  const source = asset('BattleGamePage-6ZhqY5fR.js');
  return vm.runInNewContext(source.slice(source.indexOf('const ye='), source.indexOf('const we=new Map'))+';ye()', {
    e: (_name, setup) => setup, t: value => ({value}), a: get => ({get value(){return get();}}),
    O: {}, G: {}, U: api, W: {Success:'success'},
  });
}
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'case-battles-'));
  const file=path.join(dir,'test.sqlite');
  const db=new sqlite.Database(file);
  const query=(sql,params=[])=>new Promise((resolve,reject)=>db.all(sql,params,(err,rows)=>err?reject(err):resolve(rows)));
  t.after(async()=>{await new Promise(r=>db.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  await query('CREATE TABLE cases(id INTEGER PRIMARY KEY,slug TEXT,name TEXT,price REAL,image TEXT,volatility TEXT)');
  await query("INSERT INTO cases VALUES(1,'ak','AK',399,'/ak.png','HIGH'),(2,'bow','Bow',100,'/bow.png','LOW')");
  const service=makeBattlesService({queryAdminDb:query,getAdminDb:()=>new sqlite.Database(file),
    getCaseItemsFromDb:async()=>[{id:10,name:'Skin',price:300,image:'/skin.png',rarity:'RARE',chance:100}],
    getFallbackItems:async()=>assert.fail('No fake drops'),fixImageUrl:x=>x});
  await service.ensureSchema();
  const created=await service.create({user:{id:1,username:'Creator',avatar:'/1.png'},caseSlugs:['ak','bow','ak'],rounds:2,maxPlayers:2,isPrivate:false,price:1796});
  return {query,service,uid:created.uid};
}
test('lobby uses the persisted pot instead of zero',async t=>{
  const {service}=await fixture(t),[battle]=await service.list();
  const source=asset('BattleLobbyPage-BSXGeKDe.js');
  const expression=source.match(/sum:(t\.battle\.\w+)/)[1];
  assert.equal(vm.runInNewContext(expression,{t:{battle}}),3592);
  assert.equal(battle.participants[0].userName,'Creator');
  assert.equal(battle.slots,2);
  assert.equal(battle.createdBy,'1');
});
for(const [status,state] of [['waiting','waiting'],['running','initializing'],['finished','finished']]) {
  test('compiled game store loads '+status,async t=>{
    const {service,query,uid}=await fixture(t);
    await query('UPDATE battles SET status=?',[status]);
    const api=client(async()=>({status:'success',data:{battle:await service.getByUid(uid,{withDrops:true})}}));
    const store=gameStore(api);
    await store.loadGame(uid);
    assert.equal(store.gameState.value,state);
    assert.equal(store.slotsArray.value.length,2);
    assert.equal(store.roundCount.value,6);
    assert.equal(store.game.value.cases.reduce((sum,c)=>sum+Number(c.price),0),1796);
    assert.equal(store.game.value.serverSeed===undefined,status!=='finished');
  });
}
test('finished legacy drops become ordered per-case result rounds',async t=>{
  const {service,query,uid}=await fixture(t);
  const b=await service.findRow(uid);
  await service.join({uid,user:{id:2,username:'Guest',avatar:'/2.png'}});
  for(let repeat=0;repeat<2;repeat++)for(let c=0;c<3;c++)for(let slot=0;slot<2;slot++){
    await query('INSERT INTO battle_drops(battle_id,round,slot,item_name,item_image,item_price,item_rarity) VALUES(?,?,?,?,?,?,?)',
      [b.id,repeat,slot,'Skin '+c,'/skin.png',10+c+slot,'RARE']);
  }
  await query("UPDATE battles SET status='finished',winner_id='2'");
  const store=gameStore(client(async()=>({data:{battle:await service.getByUid(uid,{withDrops:true})}})));
  await store.loadGame(uid);
  assert.equal(store.game.value.rounds.length,6);
  assert.equal(store.game.value.rounds[5].results[1].item.name,'Skin 2');
  assert.equal(store.playerTotals.value['1'],'66.00');
  assert.equal(store.playerTotals.value['2'],'72.00');
  assert.equal(store.finishResultDerived.value.bank,3592);
});
test('missing cases fail instead of silently shortening paid battle',async t=>{
  const {service}=await fixture(t);
  await assert.rejects(service.loadCases(['ak','missing']),/case|кейс/i);
});
test('client create forwards selected slots to the server field',async()=>{
  let payload;
  await client(async req=>{payload=req.data;return {data:{battleId:'id'}};}).create({cases:['ak'],slots:4});
  assert.equal(payload.maxPlayers,4);
});
test('client join rejects catch-all empty payload',async()=>{
  const result=await client(async()=>({status:'success',data:[]})).join('missing');
  assert.equal(result.status,'error');
});
test('compiled join refreshes the saved match without websocket events',async t=>{
  const {service,uid}=await fixture(t);
  const api=client(async req=>{
    if(req.method==='POST') {
      const joined=await service.join({uid,user:{id:2,username:'Guest',avatar:'/2.png'}});
      assert.equal(joined.full,true);
      await service.play(joined.battleDbId);
      return {data:{success:true,battle:await service.getByUid(uid,{withDrops:true})}};
    }
    return {data:{battle:await service.getByUid(uid,{withDrops:true})}};
  });
  const store=gameStore(api);
  await store.loadGame(uid);
  await store.joinGame(uid);
  assert.equal(store.game.value.status,'RESOLVED');
  assert.equal(store.game.value.participants.length,2);
  assert.equal(store.game.value.rounds.length,6);
});
test('compiled detail uses the frozen entry amount after catalog price changes',async t=>{
  const {service,uid,query}=await fixture(t);
  await query('UPDATE cases SET price=999');
  const battle=await service.getByUid(uid,{withDrops:true});
  const source=asset('BattleGamePage-6ZhqY5fR.js');
  const expr=source.slice(source.indexOf('re=a(()=>',source.indexOf('__name:"BattleGamePage"'))+9);
  const body=expr.slice(0,expr.indexOf('),ce=a('));
  assert.equal(vm.runInNewContext(body,{w:{value:battle}}),1796);
});
test('waiting spectator refreshes from persisted state without a socket',async()=>{
  const source=asset('BattleGamePage-6ZhqY5fR.js');
  const start=source.indexOf('async function refreshWaitingBattle(');
  assert.ok(start>=0,'HTTP refresh function missing');
  const refresh=vm.runInNewContext(source.slice(start,source.indexOf('function Te()',start))+';refreshWaitingBattle');
  let count=0;
  const store={gameState:'waiting',isLoading:false,loadGame:async(uid,options)=>{
    assert.equal(uid,'uid');assert.equal(options.silent,true);count++;
  }};
  await refresh(store,'uid');
  assert.equal(count,1);
  for(const state of ['rolling','finished','round-result']){store.gameState=state;await refresh(store,'uid');}
  assert.equal(count,1);
});
test('silent refresh does not flash the loading skeleton',async t=>{
  const {service,uid}=await fixture(t);
  let store;
  store=gameStore({getById:async()=>{assert.equal(store.isLoading.value,false);return {status:'success',data:await service.getByUid(uid,{withDrops:true})};}});
  await store.loadGame(uid,{silent:true});
  assert.equal(store.game.value.battleId,uid);
});
test('failed slot insertion does not authorize a subsequent debit',async t=>{
  const {service,query,uid}=await fixture(t);
  await query("CREATE TRIGGER reject_player BEFORE INSERT ON battle_players BEGIN SELECT RAISE(ABORT,'test failure'); END");
  const result=await service.join({uid,user:{id:2,username:'Guest',avatar:'/2.png'}});
  assert.ok(result.error);
  assert.notEqual(result.ok,true);
});
test('only creator may add a bot',async t=>{
  const {service,uid}=await fixture(t);
  const result=await service.join({uid,user:{id:2},asBot:true});
  assert.equal(result.error,'FORBIDDEN');
});
test('client accepts the actual add-bot response',async()=>{
  const result=await client(async()=>({data:{success:true,battle:{participants:[{userId:'bot-1-1',isBot:true}]}}})).addBot('uid');
  assert.equal(result.status,'success');
  assert.equal(result.data.botUserId,'bot-1-1');
});
test('failed creator insertion rolls back the new battle',async t=>{
  const {service,query}=await fixture(t);
  await query("CREATE TRIGGER reject_creator BEFORE INSERT ON battle_players BEGIN SELECT RAISE(ABORT,'test failure'); END");
  const result=await service.create({user:{id:3,username:'Third'},caseSlugs:['ak'],rounds:1,maxPlayers:2,price:399});
  assert.equal(result,null);
  assert.equal((await query('SELECT COUNT(*) AS n FROM battles'))[0].n,1);
});
for(const table of ['battles','battle_players']) {
  test('ignored insertion into '+table+' cannot create a phantom battle',async t=>{
    const {service,query}=await fixture(t);
    await query(`CREATE TRIGGER ignore_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
    const result=await service.create({user:{id:3,username:'Third'},caseSlugs:['ak'],rounds:1,maxPlayers:2,price:399});
    assert.equal(result,null);
    assert.equal((await query('SELECT COUNT(*) AS n FROM battles'))[0].n,1);
    assert.equal((await query('SELECT COUNT(*) AS n FROM battle_players'))[0].n,1);
  });
}
test('concurrent joins admit only one player to the last slot',async t=>{
  const {service,query,uid}=await fixture(t);
  const results=await Promise.all([2,3].map(id=>service.join({uid,user:{id,username:'Player '+id}})));
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.equal((await query('SELECT COUNT(*) AS n FROM battle_players'))[0].n,2);
});
for(const user of [{id:0,isGuest:true},{id:1,isGuest:true},{id:2}]) {
  test('bot access rejects '+JSON.stringify(user),async t=>{
    const {service,query,uid}=await fixture(t);
    assert.equal((await service.join({uid,user,asBot:true,viewerId:1})).error,'FORBIDDEN');
    assert.equal((await query('SELECT COUNT(*) AS n FROM battle_players'))[0].n,1);
  });
}
for(const response of [{data:[]},{data:{success:false,battle:{participants:[{userId:'bot',isBot:true}]}}},{data:{success:true,battle:{participants:[]}}}]) {
  test('client rejects invalid add-bot response '+JSON.stringify(response),async()=>{
    assert.equal((await client(async()=>response).addBot('uid')).status,'error');
  });
}
test('compiled add-bot refreshes the persisted match immediately',async t=>{
  const {service,uid}=await fixture(t);
  const store=gameStore(client(async()=>({data:{battle:await service.getByUid(uid,{withDrops:true})}})));
  await store.loadGame(uid);
  const source=asset('BattleGamePage-6ZhqY5fR.js');
  const handler=source.slice(source.indexOf('addBot:async function(){')+7,source.indexOf(',goToLobby:function()'));
  const addBot=vm.runInNewContext('('+handler+')',{
    e:{get game(){return store.game.value;},loadGame:store.loadGame},
    U:client(async()=>{
      const joined=await service.join({uid,user:{id:1},asBot:true});
      await service.play(joined.battleDbId);
      return {data:{success:true,battle:await service.getByUid(uid,{withDrops:true})}};
    }),W:{Success:'success'}
  });
  await addBot();
  assert.equal(store.game.value.status,'RESOLVED');
  assert.equal(store.game.value.participants[1].isBot,true);
});
