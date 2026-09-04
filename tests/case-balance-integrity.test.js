'use strict';
/* test_strategy:
 * artifact: case settlement and inventory sale
 * rationale: Money and item ownership must commit together; Gate 0 OFF.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Real temporary SQLite detects rollback and lost-update races.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [sqlite3, temporary filesystem]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: Gate 1 validation covered through service calls.
 *     type: unit
 *   - reason: Gate 3 UI tested separately.
 *     type: component
 *   - reason: Gate 4 client and provider deploy together; response checked here.
 *     type: contract
 *   - reason: Gate 5 no production balance mutations.
 *     type: smoke
 *   - reason: Gate 6 deterministic numeric boundaries and concurrent schedules cover this fix.
 *     type: property-based
 * deliberately_skipped:
 *   - why: Integration exercises the financial boundary without real money.
 *     what: Production opening and selling
 */
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
const {makeInventoryService}=require('../services/inventory');
async function fixture(t, env){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'case-money-')),file=path.join(dir,'test.sqlite');
  const getAdminDb=()=>new sqlite.Database(file);
  const query=(sql,p=[])=>new Promise((resolve,reject)=>{const db=getAdminDb();db.configure('busyTimeout',5000);db.all(sql,p,(e,r)=>db.close(()=>e?reject(e):resolve(r)));});
  await query('CREATE TABLE users(id INTEGER PRIMARY KEY, balance REAL)');
  await query('INSERT INTO users VALUES(1,35031.04),(2,0)');
  await query('CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,comment TEXT)');
  const factory=env?(()=>{
    const file=path.join(__dirname,'../services/inventory.js'),module={exports:{}};
    require('node:vm').runInNewContext(fs.readFileSync(file,'utf8'),{module,require:require('node:module').createRequire(file),process:{env},console});
    return module.exports.makeInventoryService;
  })():makeInventoryService;
  const service=factory({getAdminDb,queryAdminDb:query,fixImageUrl:x=>x,
    adjustBalanceById:async(id,amount,type,comment)=>{await query('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?',[amount,id]);await query('INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',[id,type,amount,comment]);return (await query('SELECT balance FROM users WHERE id=?',[id]))[0]?.balance;}});
  await service.ensureSchema();
  t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(dir);});
  return {service,query,balance:async()=>(await query('SELECT balance FROM users WHERE id=1'))[0].balance};
}
const item=(price,id=1)=>({id,name:'Test skin',image:'/test.png',price,rarity:'REGULAR'});
async function handlerFixture(t){
  const f=await fixture(t),vm=require('node:vm');
  await f.query('CREATE TABLE cases(id INTEGER PRIMARY KEY,slug TEXT,name TEXT,price REAL,status TEXT,isActive INTEGER,seriesId INTEGER)');
  await f.query("INSERT INTO cases VALUES(1,'farm-ak','farm ak',399,'active',1,NULL)");
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const start=source.indexOf("app.post(['/api/v1/cases/open'");
  const end=source.indexOf('// --- MOCK & ADMIN SYNCHRONIZED API ROUTES',start);
  let handler;const live=[];let rollCount=0;let failLive=false;let caseItems=[item(330),item(330),item(350),item(933)];
  vm.runInNewContext(source.slice(start,end),{app:{post:(_paths,h)=>handler=h},console:{error(){}},
    queryAdminDb:f.query,currentUser:async()=>({id:1,username:'test',rtp:96}),mockUser:{},guestUser:()=>({}),
    getCaseItemsFromDb:async()=>caseItems,
    buildDistribution:items=>({entries:items,rtpActual:96,source:'test'}),DEFAULT_RTP:96,MAX_RTP:100,
    balanceForSpending:async()=>f.balance(),adjustBalance:async(_req,_mock,n)=>{await f.query('UPDATE users SET balance=balance+? WHERE id=1',[n]);return f.balance();},getBalance:f.balance,
    fairness:{nextRoll:async(_id,_game,count)=>{rollCount++;return {serverHash:'hash',clientSeed:'client',startNonce:0,rolls:Array.from({length:count},(_,i)=>({roll:i}))};}},
    pickByRoll:(items,roll)=>items[roll%items.length],fixImageUrl:x=>x,inventory:f.service,
    recordTransaction:async()=>{},pushLiveDrop:x=>{if(failLive)throw new Error('test live feed failure');live.push(x);},makeWin:x=>x});
  const call=async body=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};await handler({body,params:{},auth:{sub:1}},res);return res;};
  return {...f,call,handler,live,rollCount:()=>rollCount,failLive:()=>{failLive=true;},setItems:items=>{caseItems=items;}};
}
test('AC4 actual case handler returns inventory ids without cash winnings',async t=>{const f=await handlerFixture(t);const r=await f.call({slug:'farm-ak',count:4});assert.equal(r.statusCode,200);assert.equal(r.body.data.rewardDestination,'inventory');assert.equal(r.body.data.inventoryIds.length,4);assert.equal(r.body.data.balance,33435.04);assert.equal(r.body.data.winnings,1943);assert.equal(f.live.length,4);});
for(const count of [-1,0,1.5,6,'2oops'])test(`AC4 handler rejects quantity ${count} before fairness`,async t=>{const f=await handlerFixture(t);const r=await f.call({slug:'farm-ak',count});assert.equal(r.statusCode,400);assert.equal(f.rollCount(),0);assert.equal(await f.balance(),35031.04);});
test('AC4 zero-price case is not charged 49 rubles',async t=>{const f=await handlerFixture(t);await f.query('UPDATE cases SET price=0');const r=await f.call({slug:'farm-ak',count:1});assert.equal(r.statusCode,200);assert.equal(await f.balance(),35031.04);});
test('AC4 failed case settlement publishes no live drop',async t=>{const f=await handlerFixture(t);await f.query("CREATE TRIGGER reject_case BEFORE INSERT ON inventory BEGIN SELECT RAISE(ABORT,'item failure'); END");const r=await f.call({slug:'farm-ak',count:4});assert.equal(r.statusCode,500);assert.equal(f.live.length,0);assert.equal(await f.balance(),35031.04);});
test('AC1 award preserves item cents',async t=>{const {service}=await fixture(t);const r=await service.award(1,item(765.87));assert.equal(r.value,765.87);assert.equal((await service.list(1)).totalValue,765.87);});
test('AC2 simultaneous sales cannot credit one item twice',async t=>{const {service,balance}=await fixture(t);const a=await service.award(1,item(933));const r=await Promise.all([service.sell(1,[a.id]),service.sell(1,[a.id])]);assert.equal(r.filter(x=>x.ok).length,1);assert.equal(await balance(),35964.04);});
test('AC2 ledger failure leaves the item owned',async t=>{const {service,query,balance}=await fixture(t);const a=await service.award(1,item(330));await query("CREATE TRIGGER fail_sale BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'test ledger failure'); END");await service.sell(1,[a.id]).catch(()=>{});assert.equal((await service.list(1)).count,1);assert.equal(await balance(),35031.04);});
test('AC2 rejects a partially unavailable selection',async t=>{const {service,balance}=await fixture(t);const a=await service.award(1,item(330));const r=await service.sell(1,[a.id,99999]);assert.ok(r.error);assert.equal(await balance(),35031.04);});
test('AC3 screenshot amount goes to inventory until explicitly sold',async t=>{const {service,balance}=await fixture(t);assert.equal(typeof service.settleCase,'function');const r=await service.settleCase(1,{cost:1596,drops:[item(330),item(330),item(350),item(933)],ref:'farm-ak'});assert.equal(r.rewardDestination,'inventory');assert.equal(r.winnings,1943);assert.equal(await balance(),33435.04);assert.equal((await service.list(1)).totalValue,1943);const sale=await service.sell(1,r.inventoryIds);assert.equal(sale.payout,1943);assert.equal(await balance(),35378.04);});
test('AC3 inventory insert failure rolls back the case debit',async t=>{const {service,query,balance}=await fixture(t);assert.equal(typeof service.settleCase,'function');await query("CREATE TRIGGER fail_award BEFORE INSERT ON inventory WHEN NEW.price=350 BEGIN SELECT RAISE(ABORT,'test item failure'); END");await assert.rejects(service.settleCase(1,{cost:798,drops:[item(330),item(350)],ref:'test'}),/test item failure/);assert.equal(await balance(),35031.04);assert.equal((await service.list(1)).count,0);});
test('AC3 competing openings cannot overspend',async t=>{const {service,query,balance}=await fixture(t);assert.equal(typeof service.settleCase,'function');await query('UPDATE users SET balance=399 WHERE id=1');const results=await Promise.allSettled([service.settleCase(1,{cost:399,drops:[item(330)],ref:'test'}),service.settleCase(1,{cost:399,drops:[item(330)],ref:'test'})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(await balance(),0);assert.equal((await service.list(1)).count,1);});
test('AC4 committed opening stays successful if live feed fails',async t=>{const f=await handlerFixture(t);f.failLive();const r=await f.call({slug:'farm-ak',count:4});assert.equal(r.statusCode,200);assert.equal(r.body.data.balance,33435.04);assert.equal((await f.service.list(1)).count,4);});
const tradeLink='https://steamcommunity.com/tradeoffer/new/?partner=123&token=test';
test('AC2 withdrawal refuses a partially unavailable selection',async t=>{const f=await fixture(t);const a=await f.service.award(1,item(330));const r=await f.service.requestWithdraw(1,[a.id,99999],tradeLink);assert.equal(r.error,'NOT_FOUND');assert.equal((await f.service.list(1)).count,1);assert.equal((await f.query('SELECT * FROM skin_withdrawals')).length,0);});
test('AC2 inventory lock failure rolls back withdrawal creation',async t=>{const f=await fixture(t);const a=await f.service.award(1,item(330));await f.query("CREATE TRIGGER fail_lock BEFORE UPDATE ON inventory BEGIN SELECT RAISE(ABORT,'test lock failure'); END");await f.service.requestWithdraw(1,[a.id],tradeLink).catch(()=>{});assert.equal((await f.query('SELECT * FROM skin_withdrawals')).length,0);assert.equal((await f.service.list(1)).count,1);});
test('AC2 duplicate withdrawal can reserve each item only once',async t=>{const f=await fixture(t);const a=await f.service.award(1,item(330));const r=await Promise.all([f.service.requestWithdraw(1,[a.id],tradeLink),f.service.requestWithdraw(1,[a.id],tradeLink)]);assert.equal(r.filter(x=>x.ok).length,1);assert.equal((await f.query('SELECT * FROM skin_withdrawals')).length,1);});
test('AC2 competing sale or withdrawal has exactly one winner',async t=>{const f=await fixture(t);const a=await f.service.award(1,item(330));const r=await Promise.all([f.service.sell(1,[a.id]),f.service.requestWithdraw(1,[a.id],tradeLink)]);assert.equal(r.filter(x=>x.ok).length,1);const row=(await f.query('SELECT status FROM inventory WHERE id=?',[a.id]))[0];assert.equal(await f.balance(),row.status==='sold'?35361.04:35031.04);});
test('AC2 failed cancellation keeps withdrawal pending',async t=>{const f=await fixture(t);const a=await f.service.award(1,item(330));const w=await f.service.requestWithdraw(1,[a.id],tradeLink);await f.query("CREATE TRIGGER fail_unlock BEFORE UPDATE ON inventory BEGIN SELECT RAISE(ABORT,'test unlock failure'); END");await f.service.cancelWithdraw(1,w.uid).catch(()=>{});assert.equal((await f.query('SELECT status FROM skin_withdrawals WHERE uid=?',[w.uid]))[0].status,'pending');});
test('AC4 response winnings equal the saved cent total',async t=>{const f=await handlerFixture(t);f.setItems([item(0.1),item(0.2)]);const r=await f.call({slug:'farm-ak',count:2});assert.equal(r.body.data.winnings,0.3);});
test('AC2 cancelled withdrawal makes the skin sellable once',async t=>{const f=await fixture(t);const a=await f.service.award(1,item(330));const w=await f.service.requestWithdraw(1,[a.id],tradeLink);assert.equal((await f.service.cancelWithdraw(1,w.uid)).ok,true);assert.equal((await f.service.sell(1,[a.id])).payout,330);assert.equal((await f.service.cancelWithdraw(1,w.uid)).error,'ALREADY_PROCESSED');assert.equal((await f.service.list(1)).count,0);assert.equal(await f.balance(),35361.04);});
test('AC3 configured auto-sale credits once without sellable inventory',async t=>{const f=await fixture(t,{AUTO_SELL_WINS:'1'});const r=await f.service.settleCase(1,{cost:1596,drops:[item(330),item(330),item(350),item(933)],ref:'farm-ak'});assert.equal(r.rewardDestination,'balance');assert.equal(r.balance,35378.04);assert.equal((await f.service.list(1)).count,0);assert.equal((await f.service.sell(1,r.inventoryIds)).error,'NOT_FOUND');assert.equal(await f.balance(),35378.04);});
test('AC2 configured sale fee uses saved kopecks',async t=>{const f=await fixture(t,{SELL_FEE_PERCENT:'2.5'});const r=await f.service.settleCase(1,{cost:1596,drops:[item(330),item(330),item(350),item(933)],ref:'farm-ak'});assert.equal(r.sellFeePercent,2.5);const sale=await f.service.sell(1,r.inventoryIds);assert.equal(sale.payout,1894.43);assert.equal(await f.balance(),35329.47);});
test('AC4 HTTP opening exposes an explicit sale without double credit',async t=>{
  const f=await handlerFixture(t),express=require('express'),vm=require('node:vm');
  const app=express();app.use(express.json());app.post('/api/v1/cases/open',f.handler);
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const start=source.indexOf("app.post(['/api/v1/inventory/sell'");
  const end=source.indexOf("app.post('/api/v1/inventory/:id/sell'",start);
  vm.runInNewContext(source.slice(start,end),{app,inventory:f.service,requireUser:async()=>({id:1})});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}/api/v1`;
  const post=(url,data)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const opening=await (await post('/cases/open',{slug:'farm-ak',count:4})).json();
  assert.equal(opening.data.rewardDestination,'inventory');assert.equal(opening.data.balance,33435.04);
  const ids=opening.data.inventoryIds;const sale=await (await post('/inventory/sell',{ids})).json();
  assert.equal(sale.status,'success');assert.equal(sale.data.payout,1943);assert.equal(sale.data.balance,35378.04);
  assert.equal((await post('/inventory/sell',{ids})).status,400);assert.equal(await f.balance(),35378.04);
});
