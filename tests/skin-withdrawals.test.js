'use strict';
// Strategy: HIGH money integrity. Real temporary SQLite + HTTP/DTO integration;
// no real Steam trades. Boundary values and concurrency instead of network e2e.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'skin-withdraw-')),file=path.join(dir,'test.sqlite');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const getDb=()=>new sqlite.Database(file);
 const query=(sql,args=[])=>new Promise((resolve,reject)=>{const d=getDb();d.all(sql,args,(e,r)=>d.close(()=>e?reject(e):resolve(r)));});
 for(const sql of [
  'CREATE TABLE users(id INTEGER PRIMARY KEY,balance REAL,status TEXT,trade_link TEXT)',
  'CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,market_hash_name TEXT,price REAL,image TEXT,rarity TEXT,delisted INTEGER,admin_disabled INTEGER)',
  'CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
  "INSERT INTO users VALUES(1,1000,'active','https://steamcommunity.com/tradeoffer/new/?partner=123&token=test')",
  "INSERT INTO items VALUES(1,'Skin','Skin',161.42,'/uploads/items/skin.png','RARE',0,0),(2,'Hidden','Hidden',10,'/hidden.png','RARE',1,0)"
 ])await query(sql);
 const {makeSkinWithdrawals}=require('../services/skinWithdrawals');
 return {query,service:makeSkinWithdrawals({getDb,queryAdminDb:query,fixImageUrl:x=>x}),balance:async()=>(await query('SELECT balance FROM users WHERE id=1'))[0].balance};
}
const input={items:[{name:'Skin',count:2,price:1}],requestId:'test-request-123456'};
const limits={minWithdraw:0,dailyWithdrawCap:10000};

test('cancelled requests restore the same daily allowance used by eligibility',async t=>{
 const f=await fixture(t);const r=await f.service.create(1,input,limits);
 assert.equal(await f.service.spentToday(1),322.84);
 await f.service.cancel(1,r.request_id);assert.equal(await f.service.spentToday(1),0);
 await f.service.create(1,{...input,requestId:'another-request-123456'},{...limits,dailyWithdrawCap:323});
 assert.equal(await f.service.spentToday(1),322.84);
});

test('active wager blocks debit inside the transaction',async t=>{
 const f=await fixture(t);await f.query('CREATE TABLE wallet_wagers(user_id INTEGER PRIMARY KEY,remaining_cents INTEGER)');
 await f.query('INSERT INTO wallet_wagers VALUES(1,100)');
 await assert.rejects(f.service.create(1,input,limits),/отыгрыш/);assert.equal(await f.balance(),1000);
});

test('blocked account, missing trade link and minimum fail without debit',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.service.create(1,input,{...limits,minWithdraw:500}),/Минимальная/);
 await f.query("UPDATE users SET trade_link='invalid'");
 await assert.rejects(f.service.create(1,input,limits),/ссылку/);
 await f.query("UPDATE users SET status='blocked'");
 await assert.rejects(f.service.create(1,input,limits),/недоступен/);
 assert.equal(await f.balance(),1000);
});
test('catalog has images and explicit ruble prices',async t=>{const {service}=await fixture(t);const r=await service.catalog();assert.equal(r.items.length,1);assert.equal(r.items[0].img,'/uploads/items/skin.png');assert.equal(r.items[0].priceRub,161.42);});
test('request uses server prices instead of client amount',async t=>{const f=await fixture(t);const r=await f.service.create(1,input,limits);assert.equal(r.amount_rub,322.84);assert.equal(await f.balance(),677.16);assert.ok(r.request_id);});
test('retry creates exactly one withdrawal',async t=>{const f=await fixture(t);const a=await f.service.create(1,input,limits),b=await f.service.create(1,input,limits);assert.equal(a.request_id,b.request_id);assert.equal(await f.balance(),677.16);});
test('same key with different selection is rejected',async t=>{const f=await fixture(t);await f.service.create(1,input,limits);await assert.rejects(f.service.create(1,{...input,items:[{name:'Skin',count:1}]},limits),/повтор/i);});
test('insufficient balance leaves no request',async t=>{const f=await fixture(t);await f.query('UPDATE users SET balance=10.43');await assert.rejects(f.service.create(1,input,limits),/Недостаточно/);assert.equal(await f.balance(),10.43);assert.equal((await f.query('SELECT * FROM withdrawals')).length,0);});
test('ledger failure rolls back request and debit',async t=>{const f=await fixture(t);await f.query("CREATE TRIGGER reject_tx BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'ledger fail'); END");await assert.rejects(f.service.create(1,input,limits),/ledger fail/);assert.equal(await f.balance(),1000);});
test('concurrent cancellation refunds only once',async t=>{const f=await fixture(t);const r=await f.service.create(1,input,limits);const results=await Promise.allSettled([f.service.cancel(1,r.request_id),f.service.cancel(1,r.request_id)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(await f.balance(),1000);});
test('other user cannot cancel a withdrawal',async t=>{const f=await fixture(t);const r=await f.service.create(1,input,limits);await assert.rejects(f.service.cancel(2,r.request_id),/найдена/);assert.equal(await f.balance(),677.16);});
test('admin rejection refunds once',async t=>{const f=await fixture(t);const r=await f.service.create(1,input,limits);await f.service.decide(r.request_id,'reject','admin');await assert.rejects(f.service.decide(r.request_id,'reject','admin'),/обработана/);assert.equal(await f.balance(),1000);});
for(const n of [0,11,1.5])test(`invalid quantity ${n} is rejected`,async t=>{const f=await fixture(t);await assert.rejects(f.service.create(1,{...input,items:[{name:'Skin',count:n}]},limits),/предмет/);assert.equal(await f.balance(),1000);});
test('daily cap is enforced in the debit transaction',async t=>{const f=await fixture(t);await assert.rejects(f.service.create(1,input,{...limits,dailyWithdrawCap:300}),/лимит/);assert.equal(await f.balance(),1000);});
test('claimed request cannot be cancelled while admin sends the trade',async t=>{const f=await fixture(t);const r=await f.service.create(1,input,limits);await f.service.claim(r.request_id);await assert.rejects(f.service.cancel(1,r.request_id),/обработ/);assert.equal(await f.balance(),677.16);await f.service.decide(r.request_id,'reject');assert.equal(await f.balance(),1000);});
test('approval requires claim and a Steam trade reference',async t=>{const f=await fixture(t);const r=await f.service.create(1,input,limits);await assert.rejects(f.service.decide(r.request_id,'approve'),/ссылку/);await assert.rejects(f.service.decide(r.request_id,'approve','https://steamcommunity.com/tradeoffer/123/'),/обработ/);await f.service.claim(r.request_id);await f.service.decide(r.request_id,'approve','https://steamcommunity.com/tradeoffer/123/');assert.equal(await f.balance(),677.16);await assert.rejects(f.service.cancel(1,r.request_id));});
test('simultaneous create retry debits once',async t=>{const f=await fixture(t);const [a,b]=await Promise.all([f.service.create(1,input,limits),f.service.create(1,input,limits)]);assert.equal(a.request_id,b.request_id);assert.equal(await f.balance(),677.16);});
test('HTTP contracts match wallet bundle, preserve crypto and require auth',async t=>{
 const f=await fixture(t),app=require('express')();app.use(require('express').json());
 require('../services/skinWithdrawalRoutes').register({app,service:f.service,limits:async()=>limits,requireUser:async(req,res)=>{if(req.headers['x-test-user']==='1')return{id:1};res.status(401).json({status:'error'});return null;}});
 app.post('/api/v1/wallet/withdraw',(_req,res)=>res.json({crypto:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}/api/v1/wallet`;
 const send=async(url,body,auth=true)=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{'x-test-user':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {code:r.status,body:await r.json()};};
 assert.equal((await send('/skins/withdraw-inventory',null,false)).code,401);
 assert.equal((await send('/skins/withdraw-inventory')).body.data.items[0].priceRub,161.42);
 assert.equal((await send('/withdraw',{channel:'CRYPTO'})).body.crypto,true);
 const created=(await send('/withdraw',{...input,channel:'SKINS'})).body.data;
 assert.ok(created.request_id);assert.equal((await send('/skins/withdrawals')).body.data.withdrawals[0].items[0].name,'Skin');
 assert.equal((await send(`/withdrawals/${created.request_id}/cancel`,{})).code,200);
 assert.equal((await send(`/withdrawals/${created.request_id}/cancel`,{})).code,409);
 assert.equal(await f.balance(),1000);
});
