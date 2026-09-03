'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
const { makeDepositsService } = require('../services/deposits');
/* test_strategy:
 * artifact: shared deposit confirmation
 * rationale: Money must never be lost or credited twice; Gate 0 OFF.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Real SQLite transactions exercise failures and concurrent confirmations.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [sqlite3 temporary database]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: Gate 1 validation covered through the real service.
 *     type: unit
 *   - reason: Gate 3 no UI in this service.
 *     type: e2e
 *   - reason: Gate 4 shared internal service, same deployment.
 *     type: contract
 *   - reason: Gate 5 no production money mutations permitted.
 *     type: smoke
 *   - reason: Gate 6 invariants exercised with deterministic boundaries and concurrency.
 *     type: property-based
 * deliberately_skipped:
 *   - why: Real balances must remain untouched.
 *     what: Production deposits
 */
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deposit-integrity-'));
  const file = path.join(dir, 'test.sqlite');
  const getAdminDb = () => { const db = new sqlite.Database(file); db.configure('busyTimeout',5000); return db; };
  const queryAdminDb = (sql,p=[]) => new Promise((resolve,reject) => {
    const db=getAdminDb(); db.all(sql,p,(e,r)=>db.close(()=>e?reject(e):resolve(r)));
  });
  await queryAdminDb('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, balance REAL)');
  await queryAdminDb("INSERT INTO users VALUES(1,'test',100)");
  await queryAdminDb('CREATE TABLE transactions(id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, amount REAL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  const service=makeDepositsService({getAdminDb,queryAdminDb,adjustBalanceById:async()=>null});
  t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(dir);});
  return {service,query:queryAdminDb,getAdminDb};
}
// AC1: confirmation commits the deposit, balance and ledger together.
test('AC1: confirmation credits the shared ledger',async t=>{
  const {service,query}=await fixture(t);
  const d=await service.create({user:{id:1,username:'test'},method:'manual',amount:10000});
  assert.equal((await service.confirm(d.uid)).ok,true);
  assert.equal((await query('SELECT balance FROM users'))[0].balance,10100);
  assert.equal((await query('SELECT amount FROM transactions'))[0].amount,10000);
});
test('AC1: ledger failure rolls back the deposit',async t=>{
  const {service,query}=await fixture(t);
  const d=await service.create({user:{id:1},method:'manual',amount:10});
  await query("CREATE TRIGGER reject_test BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'test ledger failure'); END");
  await assert.rejects(service.confirm(d.uid),/test ledger failure/);
  assert.equal((await service.byUid(d.uid)).status,'pending');
  assert.equal((await query('SELECT balance FROM users'))[0].balance,100);
});
test('AC2: concurrent confirmations credit exactly once',async t=>{
  const {service,query}=await fixture(t);
  const d=await service.create({user:{id:1},method:'manual',amount:10});
  const results=await Promise.all([service.confirm(d.uid),service.confirm(d.uid)]);
  assert.equal(results.filter(x=>x.ok).length,1);
  assert.equal((await query('SELECT balance FROM users'))[0].balance,110);
});
test('AC3: confirmation rejects missing users',async t=>{
  const {service}=await fixture(t);
  const d=await service.create({user:{id:404},method:'manual',amount:10});
  assert.equal((await service.confirm(d.uid)).ok,false);
  assert.equal((await service.byUid(d.uid)).status,'pending');
});
for(const amount of [-0.01,0,Infinity,NaN,0.001]) test(`AC3: rejects invalid amount ${amount}`,async t=>{
  const {service}=await fixture(t);
  const d=await service.create({user:{id:1},method:'manual',amount:10});
  assert.equal((await service.confirm(d.uid,{amount})).ok,false);
});

test('AC4: manual credit is idempotent with a persistent wager',async t=>{
  const {service,query}=await fixture(t);
  const manual={userId:1,amount:'10000',reason:'компенсация',wagerMultiplier:'10',requestId:'test-request-0001',by:'admin:1'};
  assert.equal(typeof service.manualCredit,'function');
  const results=await Promise.all([service.manualCredit(manual),service.manualCredit(manual)]);
  assert.ok(results.every(r=>r.ok));
  assert.equal((await query('SELECT balance FROM users'))[0].balance,10100);
  assert.equal((await query('SELECT COUNT(*) n FROM transactions'))[0].n,1);
  assert.equal((await service.wager(1)).remaining,'100000.00');
  await query("INSERT INTO transactions(user_id,type,amount) VALUES(1,'case_open',-250)");
  assert.equal((await service.wager(1)).remaining,'99750.00');
  await query("INSERT INTO transactions(user_id,type,amount) VALUES(1,'case_win',1000)");
  assert.equal((await service.wager(1)).remaining,'99750.00');
  assert.equal((await service.manualCredit({...manual,amount:'20'})).error,'IDEMPOTENCY_CONFLICT');
});
test('AC5: wager does not count earlier bets',async t=>{
  const {service,query}=await fixture(t);
  await query("INSERT INTO transactions(user_id,type,amount) VALUES(1,'case_open',-100000)");
  assert.equal(typeof service.manualCredit,'function');
  await service.manualCredit({userId:1,amount:'10',reason:'test',wagerMultiplier:'2',requestId:'test-request-0002'});
  assert.equal((await service.wager(1)).remaining,'20.00');
  await query("INSERT INTO transactions(user_id,type,amount) VALUES(1,'battle_entry',-20)");
  assert.equal((await service.wager(1)).hasActiveWager,false);
  await query("INSERT INTO transactions(user_id,type,amount) VALUES(1,'battle_refund',20)");
  assert.equal((await service.wager(1)).remaining,'20.00');
});

test('AC6: admin adjustment credits through the guarded HTTP route',async t=>{
  const {query,getAdminDb}=await fixture(t);
  for(const column of ['steam_id TEXT','role TEXT','status TEXT','created_at TEXT']) await query('ALTER TABLE users ADD COLUMN '+column);
  const express=require('../admin.titanrust.ru/server/node_modules/express');
  const app=express();app.use(express.json());
  require('../admin.titanrust.ru/server/userRoutes').register({app,dbAll:query,dbGet:async(s,p)=>(await query(s,p))[0],dbRun:query,getAdminDb,
    requireAdminJWT:(req,res,next)=>{if(req.headers['x-deny'])return res.sendStatus(403);req.user={userId:99,role:'SUPER_ADMIN'};next();}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const post=async(body,headers={})=>fetch('http://127.0.0.1:'+server.address().port+'/api/v1/admin/wallet/1/adjust',{
    method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const body={action:'CREDIT',amount:'10000',reason:'компенсация',wagerMultiplier:'10',requestId:'admin-request-00001'};
  assert.equal((await post(body,{'x-deny':'1'})).status,403);
  const response=await post(body);assert.equal(response.status,200,await response.clone().text());
  assert.equal((await response.json()).data.newBalance,'10100.00');
  assert.equal((await post(body)).status,200);
  assert.equal((await query('SELECT balance FROM users'))[0].balance,10100);
  const history=await fetch('http://127.0.0.1:'+server.address().port+'/api/v1/admin/wallet/1/deposits');
  const payments=await history.json();
  assert.equal(payments.data.total,1);
  assert.equal(payments.data.items[0].status,'COMPLETED');
  assert.equal(payments.data.items[0].amount,'10000.00');
});

test('AC7: wager blocks every public withdrawal alias before debit',async t=>{
  const {service,query}=await fixture(t);
  await service.manualCredit({userId:1,amount:'10',reason:'test',wagerMultiplier:'2',requestId:'withdraw-request-01'});
  const express=require('../admin.titanrust.ru/server/node_modules/express');
  const app=express();app.use((req,res,next)=>{req.auth={sub:1};next();});
  const file=path.resolve(__dirname,'../server.js'),source=fs.readFileSync(file,'utf8');
  const marker="require('./services/wagerGuard').register";
  const start=source.indexOf(marker);
  assert.ok(start>=0,'The actual site must register the withdrawal guard');
  const end=source.indexOf('\n',start);
  require('node:vm').runInNewContext(source.slice(start,end),{app,deposits:service,require:require('node:module').createRequire(file)});
  const routes=['/api/v1/wallet/withdraw','/api/v1/wallet/skins/withdraw','/api/v1/inventory/withdraw'];
  for(const route of routes)app.post(route,(req,res)=>res.json({debit:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  for(const route of routes){const r=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST'});assert.equal(r.status,403);assert.equal((await r.json()).code,'WAGER_REQUIRED');}
  await query("INSERT INTO transactions(user_id,type,amount) VALUES(1,'case_open',-20)");
  const r=await fetch('http://127.0.0.1:'+server.address().port+routes[0],{method:'POST'});
  assert.equal(r.status,200);
});

test('AC9: ladder claims survive restart without duplicate rewards',async t=>{
  const {query,getAdminDb}=await fixture(t);
  const file=path.resolve(__dirname,'../services/depositLadder.js');
  assert.ok(fs.existsSync(file),'Persistent ladder service must exist');
  const {makeDepositLadder}=require(file);
  const options={queryAdminDb:query,getAdminDb};
  const ladder=makeDepositLadder(options);
  const claim={userId:1,tierIndex:0,threshold:0,caseName:'test',item:{id:1,price:25}};
  const result=await Promise.all([ladder.claim(claim),ladder.claim(claim)]);
  assert.equal(result.filter(r=>r.ok).length,1);
  assert.equal((await query('SELECT balance FROM users'))[0].balance,125);
  const restarted=makeDepositLadder(options);
  assert.equal((await restarted.claimed(1))[0].tier_index,0);
  assert.equal((await restarted.claim(claim)).ok,false);
  assert.equal((await restarted.claim({...claim,tierIndex:1,threshold:100})).error,'CHAIN_INSUFFICIENT_DEPOSIT');
});

test('AC11: minimum credit of one kopeck persists',async t=>{
  const {service,query}=await fixture(t);
  const result=await service.manualCredit({userId:1,amount:'0.01',reason:'test',requestId:'minimum-request-01'});
  assert.equal(result.ok,true);
  assert.equal((await query('SELECT balance FROM users'))[0].balance,100.01);
});

test('AC12: a wager persistence failure rolls back the complete manual credit',async t=>{
  const {service,query}=await fixture(t);
  await service.ensureSchema();
  await query("CREATE TRIGGER reject_wager BEFORE INSERT ON wallet_wagers BEGIN SELECT RAISE(ABORT,'test wager failure'); END");
  await assert.rejects(service.manualCredit({userId:1,amount:'10',reason:'test',wagerMultiplier:'2',requestId:'wager-failure-0001'}),/test wager failure/);
  assert.equal((await query('SELECT balance FROM users'))[0].balance,100);
  assert.equal((await query('SELECT COUNT(*) n FROM deposits'))[0].n,0);
  assert.equal((await query('SELECT COUNT(*) n FROM wallet_manual_requests'))[0].n,0);
});
