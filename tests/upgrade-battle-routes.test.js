'use strict';
/* test_strategy:
 * artifact: public/admin upgrade battle HTTP adapters
 * rationale: Independent site and admin servers share schema and money, Gate 0 OFF.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Real SQLite and localhost HTTP verify authentication, envelopes, migration and persisted settings.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [sqlite3, express]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: Gate 1 logic tested through HTTP.
 *     type: unit
 *   - reason: Gate 3 UI tested separately.
 *     type: e2e
 *   - reason: Gate 4 consumer examples checked directly; no broker.
 *     type: contract
 *   - reason: Gate 5 no live money tests permitted.
 *     type: smoke
 *   - reason: Gate 6 bounded role and route decision tables.
 *     type: property-based
 */
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const express=require('../node_modules/express'),sqlite=require('../node_modules/sqlite3');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-http-')),file=path.join(dir,'db.sqlite');
 const getDb=()=>new sqlite.Database(file);
 const query=(s,p=[])=>new Promise((ok,no)=>{const d=getDb();d.all(s,p,(e,r)=>d.close(()=>e?no(e):ok(r)));});
 t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(dir);});
 await query("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,balance REAL,status TEXT,avatar TEXT)");
 await query("INSERT INTO users VALUES(1,'Alice',1000,'active',''),(2,'Bob',1000,'active','')");
 await query('CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,price REAL,image TEXT,rarity TEXT,upgraderEnabled INTEGER)');
 await query("INSERT INTO items VALUES(1,'MP5 Test',500,'','RARE',1),(2,'Expensive Test',10000,'','RARE',1),(3,'Disabled',500,'','RARE',0)");
 await query('CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
 const migration=require('../admin.titanrust.ru/server/adminSchema');
 await migration.ensureAdminSchema({dbRun:query,dbGet:async(s,p)=>(await query(s,p))[0]});
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{if(req.headers['x-user'])req.auth={sub:Number(req.headers['x-user']),mock:req.headers['x-mock']==='1'};next();});
 const access=require('../admin.titanrust.ru/server/adminAccess');
 function requireAdminJWT(req,res,next){
  const role=req.headers['x-role'];if(!role)return res.status(401).json({success:false});
  if(!access.check(role,req.method,req.path).allowed)return res.status(403).json({success:false});
  req.user={userId:99,role};next();
 }
 const {makeUpgradeBattles}=require('../services/upgradeBattles');const service=makeUpgradeBattles({getDb});
 require('../services/upgradeBattleRoutes').register({app,service});
 require('../admin.titanrust.ru/server/upgradeBattleRoutes').register({app,DB_PATH:file,requireAdminJWT});
 app.use('/api/v1',(req,res)=>res.json({catchAll:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));
 t.after(()=>new Promise(ok=>server.close(ok)));
 const request=async(url,method='GET',body,headers={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v1${url}`,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 return {request,query,service};
}
const settings={enabled:true,rtp:.95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900};
const create={requestId:'test-http-request-0001',clientSeed:'first-seed',roundBet:100,targetIds:[1,1,1]};
test('admin migration installs disabled mode',async t=>{const {request}=await fixture(t);const r=await request('/upgrade-battles/config');assert.equal(r.status,200);assert.equal(r.body.data.enabled,false);});
test('admin settings control the public mode',async t=>{const {request}=await fixture(t);const r=await request('/admin/upgrade-battles/config','PUT',settings,{'x-role':'ADMIN'});assert.equal(r.status,200);assert.equal((await request('/upgrade-battles/config')).body.data.enabled,true);});
test('economy settings cannot be changed by moderator',async t=>{const {request}=await fixture(t);assert.equal((await request('/admin/upgrade-battles/config','PUT',settings,{'x-role':'MODERATOR'})).status,403);});
test('guest and mock identities cannot reserve funds',async t=>{const {request}=await fixture(t);for(const headers of [{},{'x-user':'1','x-mock':'1'}])assert.equal((await request('/upgrade-battles/create','POST',create,headers)).status,401);});
test('create join reload return persistent room envelope',async t=>{
 const {request}=await fixture(t);await request('/admin/upgrade-battles/config','PUT',settings,{'x-role':'ADMIN'});
 const made=await request('/upgrade-battles/create','POST',create,{'x-user':'1'});assert.equal(made.status,200);const uid=made.body.data.battle.uid;
 assert.equal(made.body.data.battle.serverSeed,null);assert.equal(made.body.data.battle.viewerIsCreator,true);
 const joined=await request(`/upgrade-battles/${uid}/join`,'POST',{clientSeed:'opponent'},{'x-user':'2'});assert.equal(joined.status,200);assert.equal(joined.body.data.battle.rounds.length,6);
 const read=await request(`/upgrade-battles/${uid}`);assert.equal(read.body.data.battle.status,'finished');
 const history=await request('/admin/upgrade-battles?history=true','GET',undefined,{'x-role':'VIEWER'});assert.equal(history.body.data.battles[0].uid,uid);
});
test('catalog filters name and price without disabled targets',async t=>{const {request}=await fixture(t);assert.equal((await request('/upgrade-battles/items?minPrice=10000')).body.data.items[0].id,2);assert.equal((await request('/upgrade-battles/items?search=MP5&maxPrice=999')).body.data.items[0].id,1);assert.equal((await request('/upgrade-battles/items?search=Disabled')).body.data.total,0);});
test('root servers register adapters before fallbacks',()=>{
 const root=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert.ok(root.indexOf("require('./services/upgradeBattleRoutes')")>0);
 assert.ok(root.indexOf("require('./services/upgradeBattleRoutes')")<root.indexOf("app.use('/api/v1',"));
 const admin=fs.readFileSync(path.join(__dirname,'../admin.titanrust.ru/server/server.js'),'utf8');assert.ok(admin.indexOf("require('./upgradeBattleRoutes')")>0);
 assert.ok(admin.indexOf("require('./upgradeBattleRoutes')")<admin.indexOf("app.all('/api/v1/admin/*'"));
});
