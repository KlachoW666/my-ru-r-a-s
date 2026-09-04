'use strict';
/* test_strategy:
 * artifact: paid legacy case battles
 * rationale: Monetary writes must commit or roll back together; Gate 0 OFF.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Real SQLite triggers and concurrent connections expose partial commits.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [temporary SQLite, actual service, root handlers via vm]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: Gate 1 covered by integration through validation and payout calculations.
 *     type: unit
 *   - reason: Gate 3 backend-only; existing compiled consumer tests cover UI.
 *     type: e2e
 *   - reason: Gate 4 shared deployment, existing DTO contract suite retained.
 *     type: contract
 *   - reason: Gate 5 no production money smoke authorization.
 *     type: smoke
 *   - reason: Gate 6 bounded slot/state table plus explicit money boundaries.
 *     type: property-based
 * AC1 atomic debit/room/ledger; AC2 atomic join/rolls/payout/state.
 * AC3 retries and races cannot multiply slots/payments; AC4 creator-only free bots.
 */
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
const {makeBattlesService}=require('../services/battles');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'case-paid-')),file=path.join(dir,'db.sqlite');
 const getAdminDb=()=>new sqlite.Database(file);
 const query=(sql,p=[])=>new Promise((resolve,reject)=>{const d=getAdminDb();d.configure('busyTimeout',5000);d.all(sql,p,(e,r)=>d.close(()=>e?reject(e):resolve(r)));});
 t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});});
 await query('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar TEXT,balance REAL,status TEXT)');
 await query("INSERT INTO users VALUES(1,'One','',1000,'active'),(2,'Two','',1000,'active'),(3,'Three','',1000,'active')");
 await query('CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
 await query('CREATE TABLE cases(id INTEGER PRIMARY KEY,slug TEXT,name TEXT,price REAL,image TEXT,volatility TEXT)');
 await query("INSERT INTO cases VALUES(1,'ak','AK',399,'/ak.png','HIGH')");
 await query('CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,price REAL,image TEXT,rarity TEXT)');
 await query("INSERT INTO items VALUES(1,'Skin',500,'/skin.png','RARE')");
 await query('CREATE TABLE case_items(id INTEGER PRIMARY KEY,case_id INTEGER,item_id INTEGER,chance REAL,ticketRangeFrom INTEGER,ticketRangeTo INTEGER)');
 await query('INSERT INTO case_items VALUES(1,1,1,100,0,0)');
 const service=makeBattlesService({getAdminDb,queryAdminDb:query,fixImageUrl:x=>x,getCaseItemsFromDb:async()=>assert.fail('paid flow must read catalog on its own transaction')});
 await service.ensureSchema();
 return {service,query,balances:async()=>(await query('SELECT balance FROM users ORDER BY id')).map(r=>r.balance)};
}
const input=(extra={})=>({user:{id:1},caseSlugs:['ak'],rounds:1,maxPlayers:2,isPrivate:false,requestId:'create-request-0001',...extra});
test('paid methods exist',async t=>{const{service}=await fixture(t);assert.equal(typeof service.createPaid,'function');assert.equal(typeof service.joinPaid,'function');});
test('create retries charge once despite changed catalog prices',async t=>{
 const f=await fixture(t),b=await f.service.createPaid(input());
 await f.query('UPDATE cases SET price=900');
 const retry=await f.service.createPaid(input());
 assert.equal(retry.uid,b.uid);assert.equal(retry.price,399);assert.deepEqual(await f.balances(),[601,1000,1000]);
 assert.equal((await f.query('SELECT COUNT(*) n FROM transactions'))[0].n,1);
 await assert.rejects(f.service.createPaid(input({rounds:2})),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
for(const target of ['battle_players','transactions'])test('create rolls back failed '+target,async t=>{
 const f=await fixture(t);await f.query(`CREATE TRIGGER fail BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'injected'); END`);
 await assert.rejects(f.service.createPaid(input()));assert.deepEqual(await f.balances(),[1000,1000,1000]);
 assert.equal((await f.query('SELECT COUNT(*) n FROM battles'))[0].n,0);
 assert.equal((await f.query('SELECT COUNT(*) n FROM transactions'))[0].n,0);
});
test('join pays the entry pot, not the skin total, exactly once',async t=>{
 const f=await fixture(t),b=await f.service.createPaid(input());
 const result=await f.service.joinPaid({uid:b.uid,user:{id:2}});
 assert.equal(result.result.pot,798);assert.equal(result.result.winners.length,2);
 assert.deepEqual(await f.balances(),[1000,1000,1000]);
 const retry=await f.service.joinPaid({uid:b.uid,user:{id:2}});assert.equal(retry.replayed,true);
 assert.equal((await f.query("SELECT COUNT(*) n FROM transactions WHERE type='battle_win'"))[0].n,2);
 assert.equal((await f.query('SELECT COUNT(*) n FROM battle_drops'))[0].n,2);
 assert.equal((await f.service.findRow(b.uid)).status,'finished');
});
for(const [name,sql] of [
 ['slot',"CREATE TRIGGER fail BEFORE INSERT ON battle_players BEGIN SELECT RAISE(ABORT,'injected'); END"],
 ['debit',"CREATE TRIGGER fail BEFORE UPDATE OF balance ON users WHEN NEW.balance<OLD.balance BEGIN SELECT RAISE(ABORT,'injected'); END"],
 ['entry ledger',"CREATE TRIGGER fail BEFORE INSERT ON transactions WHEN NEW.type='battle_entry' BEGIN SELECT RAISE(ABORT,'injected'); END"],
 ['drop',"CREATE TRIGGER fail BEFORE INSERT ON battle_drops BEGIN SELECT RAISE(ABORT,'injected'); END"],
 ['payout',"CREATE TRIGGER fail BEFORE UPDATE OF balance ON users WHEN NEW.balance>OLD.balance BEGIN SELECT RAISE(ABORT,'injected'); END"],
 ['win ledger',"CREATE TRIGGER fail BEFORE INSERT ON transactions WHEN NEW.type='battle_win' BEGIN SELECT RAISE(ABORT,'injected'); END"],
 ['finish',"CREATE TRIGGER fail BEFORE UPDATE OF status ON battles WHEN NEW.status='finished' BEGIN SELECT RAISE(ABORT,'injected'); END"]
])test('join rollback at '+name,async t=>{
 const f=await fixture(t),b=await f.service.createPaid(input());await f.query(sql);
 await assert.rejects(f.service.joinPaid({uid:b.uid,user:{id:2}}));
 assert.deepEqual(await f.balances(),[601,1000,1000]);
 assert.equal((await f.query('SELECT COUNT(*) n FROM battle_players'))[0].n,1);
 assert.equal((await f.query('SELECT COUNT(*) n FROM battle_drops'))[0].n,0);
 assert.equal((await f.query('SELECT COUNT(*) n FROM transactions'))[0].n,1);
 assert.equal((await f.service.findRow(b.uid)).status,'waiting');
 await f.query('DROP TRIGGER fail');await f.service.joinPaid({uid:b.uid,user:{id:2}});
 assert.equal((await f.service.findRow(b.uid)).status,'finished');
});
test('concurrent last-slot joins cannot create extra debits or payouts',async t=>{
 const f=await fixture(t),b=await f.service.createPaid(input());
 const outcomes=await Promise.allSettled([2,3].map(id=>f.service.joinPaid({uid:b.uid,user:{id}})));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await f.query('SELECT COUNT(*) n FROM battle_players'))[0].n,2);
 assert.equal((await f.query('SELECT COUNT(*) n FROM transactions'))[0].n,4);
 assert.deepEqual(await f.balances(),[1000,1000,1000]);
});
test('concurrent duplicate create requests share one charged room',async t=>{
 const f=await fixture(t);const r=await Promise.all([f.service.createPaid(input()),f.service.createPaid(input())]);
 assert.equal(r[0].uid,r[1].uid);assert.deepEqual(await f.balances(),[601,1000,1000]);
});
test('bot requires creator and does not debit its caller',async t=>{
 const f=await fixture(t),b=await f.service.createPaid(input({maxPlayers:3}));
 for(const user of [{id:2},{id:1,isGuest:true}])await assert.rejects(f.service.joinPaid({uid:b.uid,user,asBot:true,requestId:'bot-request-00001'}));
 const bot=await f.service.joinPaid({uid:b.uid,user:{id:1},asBot:true,requestId:'bot-request-00001'});
 const retry=await f.service.joinPaid({uid:b.uid,user:{id:1},asBot:true,requestId:'bot-request-00001'});
 assert.equal(retry.botUserId,bot.botUserId);assert.deepEqual(await f.balances(),[601,1000,1000]);
 assert.equal((await f.query('SELECT COUNT(*) n FROM battle_players'))[0].n,2);
 assert.equal((await f.query('SELECT COUNT(*) n FROM transactions'))[0].n,1);
 await f.service.joinPaid({uid:b.uid,user:{id:1},asBot:true,requestId:'bot-request-00002'});
 assert.deepEqual(await f.balances(),[1000,1000,1000]);
 assert.equal((await f.query("SELECT COUNT(*) n FROM transactions WHERE type='battle_win'"))[0].n,1);
});
test('insufficient balance never reserves a slot',async t=>{
 const f=await fixture(t),b=await f.service.createPaid(input());await f.query('UPDATE users SET balance=398.99 WHERE id=2');
 await assert.rejects(f.service.joinPaid({uid:b.uid,user:{id:2}}),e=>e.code==='INSUFFICIENT_BALANCE');
 assert.equal((await f.query('SELECT COUNT(*) n FROM battle_players'))[0].n,1);
});
