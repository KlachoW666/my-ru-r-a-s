'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
/* test_strategy:
 * artifact: upgrade battles
 * rationale: Persistent multiplayer money settlement, Gate 0 OFF.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Real transactions must roll back and serialize concurrent joins.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [temporary SQLite]
 *     gate: Gate 2
 *   - rationale: Reproducible fair rolls and payout invariants.
 *     type: unit
 *     size: small
 *     framework: node:test
 *     dependencies: []
 *     gate: Gate 1
 * rejected_types:
 *   - reason: UI is tested separately, Gate 3.
 *     type: component
 *   - reason: Same deployment, Gate 4.
 *     type: contract
 *   - reason: No production balances may be touched, Gate 5.
 *     type: smoke
 *   - reason: Deterministic seed corpus exercises invariants without another dependency, Gate 6.
 *     type: property-based
 * deliberately_skipped:
 *   - why: Money tests use synthetic accounts only.
 *     what: Live paid games
 */
const load=()=>require('../services/upgradeBattles');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-battles-'));
 const file=path.join(dir,'test.sqlite');
 const getDb=()=>new sqlite.Database(file);
 const query=(s,p=[])=>new Promise((ok,no)=>{const d=getDb();d.all(s,p,(e,r)=>d.close(()=>e?no(e):ok(r)));});
 await query("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,balance REAL,status TEXT,avatar TEXT)");
 await query("INSERT INTO users VALUES(1,'one',10000,'active',''),(2,'two',10000,'active',''),(3,'three',10000,'active','')");
 await query('CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,price REAL,image TEXT,rarity TEXT,upgraderEnabled INTEGER)');
 await query("INSERT INTO items VALUES(1,'A',200,'','REGULAR',1),(2,'B',300,'','REGULAR',1),(3,'C',400,'','REGULAR',1)");
 await query('CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
 await query('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
 await load().ensureSchema((s,p)=>query(s,p));
 let clock=1700000000000;
 const service=load().makeUpgradeBattles({getDb,now:()=>clock});
 await service.configure({enabled:true,rtp:0.95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900},'test-admin');
 t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(dir);});
 return {query,service,getDb,advance:ms=>{clock+=ms;}};
}
const body={requestId:'create-request-00001',roundBet:100,targetIds:[1,2,3],clientSeed:'creator-seed'};
test('module exports persistent battle service',()=>assert.equal(typeof load().makeUpgradeBattles,'function'));
test('creation reserves once without counting an unplayed wager',async t=>{
 const {service,query}=await fixture(t);
 const a=await service.create(1,body);const b=await service.create(1,body);
 assert.equal(a.uid,b.uid);assert.equal(a.serverSeed,null);assert.equal(a.entryPrice,300);
 assert.equal((await query('SELECT balance FROM users WHERE id=1'))[0].balance,9700);
 assert.equal((await query("SELECT * FROM transactions WHERE type='battle_entry'")).length,0);
 await assert.rejects(service.create(1,{...body,roundBet:50}),/повторного запроса/i);
});
test('two simultaneous joiners cannot charge a third player',async t=>{
 const {service,query}=await fixture(t);const room=await service.create(1,body);
 const results=await Promise.allSettled([service.join(2,room.uid,{clientSeed:'second'}),service.join(3,room.uid,{clientSeed:'third'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const d=await service.get(room.uid,1);
 assert.equal(d.status,'finished');assert.equal(d.rounds.length,6);assert.equal(d.players.length,2);
 assert.equal(d.pot,d.rounds.reduce((n,r)=>n+r.value,0));
 assert.equal(d.players.reduce((n,p)=>n+p.payout,0),d.pot);
 const loserId=[2,3].find(id=>!d.players.some(p=>p.userId===id));
 assert.equal((await query('SELECT balance FROM users WHERE id=?',[loserId]))[0].balance,10000);
 const balances=await query('SELECT sum(balance) n FROM users');assert.equal(balances[0].n,30000-600+d.pot);
 const before=JSON.stringify(await query('SELECT * FROM transactions'));
 await service.join(d.players[1].userId,room.uid,{clientSeed:'second'});
 assert.equal(JSON.stringify(await query('SELECT * FROM transactions')),before);
 assert.equal(require('node:crypto').createHash('sha256').update(d.serverSeed).digest('hex'),d.serverHash);
 for(const r of d.rounds)assert.equal(r.roll,load().roll(d.serverSeed,d.uid,d.players.map(p=>p.clientSeed),r.roundIndex,r.slot));
});
test('cancel refunds exactly once after restart',async t=>{
 const {service,query,getDb}=await fixture(t);const r=await service.create(1,body);
 const restarted=load().makeUpgradeBattles({getDb,now:()=>1700000000000});
 await assert.rejects(restarted.cancel(2,r.uid),/создатель/i);
 await restarted.cancel(1,r.uid);await restarted.cancel(1,r.uid);
 assert.equal((await query('SELECT balance FROM users WHERE id=1'))[0].balance,10000);
 await assert.rejects(restarted.join(2,r.uid,{clientSeed:'join'}),/закрыт/i);
});
test('expiry refunds without a browser or opponent',async t=>{
 const {service,query,advance}=await fixture(t);const r=await service.create(1,body);advance(901000);
 await service.expire();await service.expire();assert.equal((await service.get(r.uid)).status,'cancelled');
 assert.equal((await query('SELECT balance FROM users WHERE id=1'))[0].balance,10000);
});
test('settlement failure rolls back opponent debit',async t=>{
 const {service,query}=await fixture(t);const r=await service.create(1,body);
 await query("CREATE TRIGGER fail_round BEFORE INSERT ON upgrade_battle_rounds BEGIN SELECT RAISE(ABORT,'test rollback'); END");
 await assert.rejects(service.join(2,r.uid,{clientSeed:'join'}),/test rollback/);
 assert.equal((await service.get(r.uid)).status,'waiting');
 assert.equal((await query('SELECT balance FROM users WHERE id=2'))[0].balance,10000);
 assert.equal((await query('SELECT * FROM upgrade_battle_players')).length,1);
});
test('targets and RTP remain frozen after creation',async t=>{
 const {service,query}=await fixture(t);const r=await service.create(1,body);
 await query('UPDATE items SET price=99999');
 await service.configure({enabled:true,rtp:0.8,minRoundBet:1,maxRoundBet:10000,waitSeconds:900},'test-admin');
 const d=await service.join(2,r.uid,{clientSeed:'join'});
 assert.equal(d.rtp,0.95);assert.deepEqual(d.targets.map(i=>i.price),[200,300,400]);
 assert.equal(d.targets[0].chance,0.475);
});
for(const value of [0,-1,0.001,Infinity,NaN,10000.01])test(`reject invalid per-round bet ${value}`,async t=>{
 const {service,query}=await fixture(t);
 await assert.rejects(service.create(1,{...body,roundBet:value}));
 assert.equal((await query('SELECT balance FROM users WHERE id=1'))[0].balance,10000);
});
test('disabled mode blocks new games but permits refund',async t=>{
 const {service}=await fixture(t);const r=await service.create(1,body);
 await service.configure({enabled:false,rtp:0.95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900},'test-admin');
 await assert.rejects(service.join(2,r.uid,{clientSeed:'join'}),/выключен/i);
 await service.cancel(1,r.uid);
});
test('self-join and banned users cannot play',async t=>{
 const {service,query}=await fixture(t);const r=await service.create(1,body);
 await assert.rejects(service.join(1,r.uid,{clientSeed:'join'}),/собственный/i);
 await query("UPDATE users SET status='banned' WHERE id=2");
 await assert.rejects(service.join(2,r.uid,{clientSeed:'join'}),/заблокирован/i);
});
test('tie splits cents without inventing a payout',()=>{
 assert.deepEqual(load().splitPot([100,100],201),[101,100]);
 assert.deepEqual(load().splitPot([0,0],0),[0,0]);
 assert.deepEqual(load().splitPot([0,200],200),[0,200]);
});
