'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const express = require('../admin.titanrust.ru/server/node_modules/express');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
/*
test_strategy:
  artifact: content API
  rationale: Compiled forms disagree with SQLite handlers; test real requests and persisted rows.
  criticality: HIGH
  selected_types:
    - rationale: SQL filtering, DTOs and mutations need real HTTP and SQLite (also covers Gate 1 branches).
      type: integration
      size: medium
      framework: node:test
      dependencies: [Express, SQLite in temporary directory]
      gate: Gate 2
  rejected_types:
    - reason: Branches covered by integration without repository doubles.
      type: unit
    - reason: Compiled admin UI has no component sources; browser verification separate.
      type: component
    - reason: Consumer ships in same repository.
      type: contract
    - reason: CRUD domains covered by equivalence and boundary examples; no solver introduced.
      type: property-based
  deliberately_skipped:
    - why: No production deployment authorized.
      what: Post-deploy smoke (Gate 5).
    - why: Passkey login requires user participation.
      what: Authenticated browser E2E (Gate 3); cannot claim it passed.
Test Cases to Cover:
- [integration] AC1 item name/id/enabled filters and pagination.
- [integration] AC2 case status filter and recoverable deactivation.
- [integration] AC3 page upsert, types and JSON roundtrip.
- [integration] AC4 series schedule contract and image clearing.
- [integration] AC5 catalogue composition persists, invalid input leaves no partial case.
- [integration] AC6 import toggles matching items without deleting catalogue rows.
*/
// AC12: production series lacked sortOrder; test old schemas through real HTTP.
test('old series schema migrates before list and schedule queries',async t=>{
  const f=await fixture(t);
  for(const col of ['sortOrder','description','image','titleImage']) await f.dbRun(`ALTER TABLE series DROP COLUMN ${col}`);
  const responses=await Promise.all([f.request('GET','/cases/series'),f.request('GET','/cases/series/schedule')]);
  for(const r of responses)assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(responses[0].body.data[0].name,'Standard');
  assert.equal((await f.dbGet('SELECT isLimited FROM series WHERE id=1')).isLimited,1);
  const saved=await f.request('PUT','/cases/series/1',{name:'Preserved',sortOrder:7,image:'/new.webp'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal((await f.dbGet('SELECT sortOrder FROM series WHERE id=1')).sortOrder,7);
});

// AC13: the production database can predate the current case form. Both create
// and edit must run only after the additive compatibility migration finishes.
test('old case schema migrates before creating and editing cases',async t=>{
  const f=await fixture(t);
  for(const col of ['sortOrder','isBlogger','exclusiveTo','seriesId','status','isActive','archived','category']) {
    await f.dbRun(`ALTER TABLE cases DROP COLUMN ${col}`);
  }
  for(const col of ['ticketRangeFrom','ticketRangeTo']) await f.dbRun(`ALTER TABLE case_items DROP COLUMN ${col}`);
  const created=await f.request('POST','/cases',{name:'Legacy create',slug:'legacy-create',price:75,
    sortOrder:4,isBlogger:true,exclusiveTo:'STREAMER',items:[{id:1,chance:100,ticketRangeFrom:1,ticketRangeTo:1000000}]});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const edited=await f.request('PUT',`/cases/${created.body.data.id}`,{name:'Legacy edited',price:80,
    sortOrder:6,isBlogger:false,items:[{id:2,chance:100,ticketRangeFrom:1,ticketRangeTo:1000000}]});
  assert.equal(edited.status,200,JSON.stringify(edited.body));
  const row=await f.dbGet('SELECT * FROM cases WHERE id=?',[created.body.data.id]);
  assert.equal(row.name,'Legacy edited');assert.equal(row.sortOrder,6);assert.equal(row.isActive,1);
  const composition=await f.dbGet('SELECT * FROM case_items WHERE case_id=?',[created.body.data.id]);
  assert.equal(composition.item_id,2);assert.equal(composition.ticketRangeTo,1000000);
});

test('picker price comparisons filter before pagination',async t=>{
  const f=await fixture(t);
  await f.dbRun("INSERT INTO items(id,name,market_hash_name,price,rarity) VALUES(3,'AK boundary','AK boundary',10000,'RARE'),(4,'AK above','AK above',10000.01,'RARE'),(5,'AK below','AK below',9999.99,'RARE')");
  const r=await f.request('GET','/cases/catalog-items?name=AK&priceMin=10000&sortDir=asc&limit=1');
  assert.equal(r.body.data[0].id,3);assert.equal(r.body.pagination.total,2);
  const lt=await f.request('GET','/cases/catalog-items?name=AK&priceLt=10000');
  assert.deepEqual(lt.body.data.map(i=>i.id),[5]);
  const gt=await f.request('GET','/cases/catalog-items?name=AK&priceGt=10000');
  assert.deepEqual(gt.body.data.map(i=>i.id),[4]);
});

test('auto RTP survives case save and matches the game distribution',async t=>{
  const f=await fixture(t);
  const {solveCaseRtp}=await import('../admin.titanrust.ru/public/assets/case-form-tools.mjs');
  const solved=solveCaseRtp([{id:1,price:10},{id:2,price:90}],80);
  assert.equal(solved.feasible,true);
  const saved=await f.request('PUT','/cases/1',{name:'Active',price:80,items:solved.items});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const items=await f.dbAll('SELECT i.*,ci.chance,ci.ticketRangeFrom,ci.ticketRangeTo FROM case_items ci JOIN items i ON i.id=ci.item_id WHERE ci.case_id=1');
  const distribution=require('../services/drops').buildDistribution(items,{casePrice:80});
  assert.equal(distribution.source,'tickets');
  assert.ok(Math.abs(distribution.ev/80-.96)<.00001);
});

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'titan-content-'));
  const DB_PATH=path.join(dir,'test.sqlite');
  const db=new sqlite.Database(DB_PATH);
  const dbRun=(s,a=[])=>new Promise((ok,no)=>db.run(s,a,function(e){e?no(e):ok({lastID:this.lastID,changes:this.changes});}));
  const dbAll=(s,a=[])=>new Promise((ok,no)=>db.all(s,a,(e,r)=>e?no(e):ok(r)));
  const dbGet=async(s,a)=>(await dbAll(s,a))[0];
  for(const sql of [
    `CREATE TABLE items(id INTEGER PRIMARY KEY,market_hash_name TEXT UNIQUE,name TEXT,price REAL,rarity TEXT,color TEXT,image TEXT,chance REAL DEFAULT 0,ticketRangeFrom INTEGER DEFAULT 0,ticketRangeTo INTEGER DEFAULT 0,upgraderEnabled INTEGER DEFAULT 0,delisted INTEGER DEFAULT 0,admin_disabled INTEGER DEFAULT 0,rarity_color TEXT,classid TEXT,updated_at TEXT)`,
    `CREATE TABLE cases(id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,price REAL,image TEXT,volatility TEXT,sortOrder INTEGER DEFAULT 0,isBlogger INTEGER DEFAULT 0,exclusiveTo TEXT,seriesId INTEGER,status TEXT DEFAULT 'active',isActive INTEGER DEFAULT 1,archived INTEGER DEFAULT 0,category TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE case_items(id INTEGER PRIMARY KEY,case_id INTEGER,item_id INTEGER,chance REAL DEFAULT 0,ticketRangeFrom INTEGER DEFAULT 0,ticketRangeTo INTEGER DEFAULT 0,UNIQUE(case_id,item_id))`,
    `CREATE TABLE series(id INTEGER PRIMARY KEY,name TEXT,description TEXT,image TEXT,titleImage TEXT,sortOrder INTEGER DEFAULT 0,isLimited INTEGER DEFAULT 0,isSecret INTEGER DEFAULT 0,status TEXT DEFAULT 'active',created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE pages(id INTEGER PRIMARY KEY,slug TEXT UNIQUE,title TEXT,content TEXT,type TEXT)`,
    `INSERT INTO items(id,market_hash_name,name,price,rarity,color,upgraderEnabled,rarity_color,classid) VALUES(1,'Alpha','Alpha',10,'REGULAR','756767',1,'a7ec2e','123'),(2,'Beta','Beta',90,'RARE','35a3f1',0,'35a3f1','456')`,
    `INSERT INTO series(id,name,titleImage,isLimited) VALUES(1,'Standard','/old.webp',1)`,
    `INSERT INTO cases(id,slug,name,price,seriesId) VALUES(1,'active','Active',50,1)`,
    `INSERT INTO cases(id,slug,name,price,status,isActive,seriesId) VALUES(2,'inactive','Inactive',50,'inactive',0,1)`,
    `INSERT INTO case_items(case_id,item_id,chance) VALUES(1,1,100)`
  ]) await dbRun(sql);
  const app=express(); app.use(express.json());
  const filename=path.resolve(__dirname,'../admin.titanrust.ru/server/server.js');
  const source=fs.readFileSync(filename,'utf8');
  const registration="require('./contentRoutes').register";
  const context={app,DB_PATH,dbAll,dbGet,dbRun,console,require:createRequire(filename),requireAdminJWT:(req,res,next)=>{
    if(req.headers['x-deny'])return res.status(403).json({success:false});
    req.user={username:'test-admin',role:'SUPER_ADMIN'};next();
  }};
  if(source.includes(registration)) {
    const start=source.indexOf(registration),end=source.indexOf('\n',start);
    vm.runInNewContext(source.slice(start,end),context);
  } else {
    const start=source.indexOf("app.get('/api/v1/admin/cases/items',");
    const end=source.indexOf("app.get('/api/v1/admin/rtp/cases/",start);
    vm.runInNewContext(source.slice(start,end),context);
    const p=source.indexOf("app.get('/api/v1/admin/pages',");
    const q=source.indexOf("app.get('/api/v1/admin/withdrawals',",p);
    vm.runInNewContext(source.slice(p,q),context);
  }
  app.all('/api/v1/admin/*',(req,res)=>res.json({success:true,data:[],catchAll:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));fs.unlinkSync(DB_PATH);fs.rmdirSync(dir);});
  const request=async(method,url,body)=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin${url}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{data=raw}return {status:r.status,body:data};
  };
  return {request,dbGet,dbAll,dbRun,DB_PATH};
}
for(const [query,id]of [['name=Beta',2],['ids[]=2',2],['upgraderEnabled=false',2],['upgraderEnabled=true',1]])test(`AC1 items filter ${query}`,async t=>{
  const f=await fixture(t),r=await f.request('GET','/cases/items?'+query);
  assert.deepEqual(r.body.data.map(x=>x.id),[id]);assert.equal(r.body.pagination.total,1);
});
test('AC1 catalogue exposes external metadata',async t=>{
  const f=await fixture(t),r=await f.request('GET','/cases/catalog-items?type_color=a7ec2e');
  assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].typeColor,'a7ec2e');assert.equal(r.body.data[0].externalId,'123');
});
test('AC2 case filters respect inactive status',async t=>{
  const f=await fixture(t),r=await f.request('GET','/cases?status=inactive');
  assert.deepEqual(r.body.data.map(x=>x.id),[2]);assert.equal(r.body.pagination.total,1);
});
test('case contents are returned from highest price to lowest',async t=>{
  const f=await fixture(t);
  await f.dbRun('INSERT INTO case_items(case_id,item_id,chance) VALUES(1,2,0)');
  const r=await f.request('GET','/cases?status=active');
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(r.body.data[0].items.map(item=>item.id),[2,1]);
});
test('AC2 deactivate preserves composition for reactivation',async t=>{
  const f=await fixture(t);await f.request('DELETE','/cases/1');
  assert.equal((await f.dbGet('SELECT COUNT(*) n FROM case_items WHERE case_id=1')).n,1);
  assert.equal((await f.dbGet('SELECT isActive FROM cases WHERE id=1')).isActive,0);
  assert.equal((await f.request('POST','/cases/1/reactivate')).status,200);
  assert.equal((await f.dbGet('SELECT isActive FROM cases WHERE id=1')).isActive,1);
});
test('AC3 pages upsert structured content by type',async t=>{
  const f=await fixture(t);
  await f.request('POST','/pages',{type:'faq',content:{title:'One'}});
  await f.request('POST','/pages',{type:'faq',content:{title:'Two'}});
  const r=await f.request('GET','/pages?type=faq');
  assert.equal(r.body.data.length,1);assert.deepEqual(r.body.data[0].content,{title:'Two'});
  assert.equal(r.body.data[0].pageType,'faq');assert.equal(r.body.data[0].version,2);
});
test('AC3 page type creation persists',async t=>{
  const f=await fixture(t);await f.request('POST','/page/types',{type:'support'});
  const r=await f.request('GET','/page/types');assert.ok((r.body.data.types||r.body.data).includes('support'));
});
test('AC4 schedule entries wrap series',async t=>{
  const f=await fixture(t),r=await f.request('GET','/cases/series/schedule');
  assert.equal(r.body.data[0].series.id,1);
});
test('AC4 removing series image clears persisted value',async t=>{
  const f=await fixture(t);await f.request('PUT','/cases/series/1',{title_image:''});
  assert.equal((await f.dbGet('SELECT titleImage FROM series WHERE id=1')).titleImage,'');
});
test('AC5 catalogue form persists all chosen items',async t=>{
  const f=await fixture(t),r=await f.request('POST','/cases/from-catalog',{name:'New',slug:'new',price:50,items:[
    {catalogItemId:1,chance:50,ticketRangeFrom:1,ticketRangeTo:500000},
    {catalogItemId:2,chance:50,ticketRangeFrom:500001,ticketRangeTo:1000000}
  ]});
  assert.equal(r.status,200);const rows=await f.dbAll('SELECT item_id,chance FROM case_items WHERE case_id=? ORDER BY item_id',[r.body.data.id]);
  assert.deepEqual(rows,[{item_id:1,chance:50},{item_id:2,chance:50}]);
});
test('AC5 invalid item must not leave a partially created case',async t=>{
  const f=await fixture(t),r=await f.request('POST','/cases',{name:'Broken',slug:'broken',price:50,items:[999]});
  assert.equal(r.status,400);assert.equal(await f.dbGet("SELECT id FROM cases WHERE slug='broken'"),undefined);
});
test('AC5 create form persists an uploaded image and twenty-one selected items',async t=>{
  const f=await fixture(t);
  for(let id=3;id<=21;id++)await f.dbRun(
    'INSERT INTO items(id,market_hash_name,name,price,rarity) VALUES(?,?,?,?,?)',
    [id,`Item ${id}`,`Item ${id}`,id*500,'GOLD']);
  const items=Array.from({length:21},(_,index)=>({
    id:index+1,
    chance:100/21,
    ticketRangeFrom:index*1000+1,
    ticketRangeTo:(index+1)*1000
  }));
  const r=await f.request('POST','/cases',{
    name:'Кейс за 9999',slug:'',image:'/uploads/cases/new-case.webp',price:9999,
    volatility:'AVERAGE',sortOrder:1,isBlogger:false,items
  });
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.match(r.body.data.slug,/^[a-z0-9-]+$/);
  assert.equal(r.body.data.image,'/uploads/cases/new-case.webp');
  assert.equal((await f.dbGet('SELECT COUNT(*) n FROM case_items WHERE case_id=?',[r.body.data.id])).n,21);
});
test('AC5 export is JSON expected by CSV download button',async t=>{
  const f=await fixture(t),r=await f.request('GET','/cases/export?status=active');
  assert.ok(Array.isArray(r.body.data));assert.equal(r.body.data[0].items[0].catalogItemName,'Alpha');
});
test('AC7 site catalog hides deactivated cases without demo fallback',async t=>{
  const f=await fixture(t),filename=path.resolve(__dirname,'../server.js'),s=fs.readFileSync(filename,'utf8');
  const start=s.indexOf('async function getLiveSeries()'),end=s.indexOf('// Get all live cases flat list',start);
  const live=vm.runInNewContext(s.slice(start,end)+'\ngetLiveSeries;',{
    queryAdminDb:f.dbAll,getLiveItems:async()=>[],fixImageUrl:x=>x
  });
  let rows=JSON.parse(JSON.stringify(await live()));assert.deepEqual(rows.flatMap(s=>s.cases).map(c=>c.slug),['active']);
  await f.request('DELETE','/cases/1');rows=JSON.parse(JSON.stringify(await live()));assert.deepEqual(rows,[]);
});
test('AC7 site catalog hides cases belonging to inactive series',async t=>{
  const f=await fixture(t);await f.dbRun("UPDATE series SET status='inactive'");
  const s=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
  const a=s.indexOf('async function getLiveSeries()'),b=s.indexOf('// Get all live cases flat list',a);
  const live=vm.runInNewContext(s.slice(a,b)+'\ngetLiveSeries;',{queryAdminDb:f.dbAll,getLiveItems:async()=>[],fixImageUrl:x=>x});
  assert.equal((await live()).length,0);
});
test('AC7 deposit-chain cases are hidden from the public catalogue',async t=>{
  const f=await fixture(t);await f.dbRun("UPDATE cases SET exclusiveTo='DEPOSIT_CHAIN' WHERE id=1");
  const s=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
  const a=s.indexOf('async function getLiveSeries('),b=s.indexOf('// Get all live cases flat list',a);
  const live=vm.runInNewContext(s.slice(a,b)+'\ngetLiveSeries;',{queryAdminDb:f.dbAll,getLiveItems:async()=>[],fixImageUrl:x=>x});
  assert.deepEqual(JSON.parse(JSON.stringify(await live())),[]);
  const ladder=JSON.parse(JSON.stringify(await live({exclusiveTo:'DEPOSIT_CHAIN'})));
  assert.deepEqual(ladder.flatMap(series=>series.cases).map(c=>c.slug),['active']);
});
test('AC7 disabled case cannot reach wallet debit',async t=>{
  const f=await fixture(t),app=express();app.use(express.json());
  const s=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
  const a=s.indexOf("app.post(['/api/v1/cases/open'");const b=s.indexOf('// --- MOCK & ADMIN SYNCHRONIZED API ROUTES ---',a);
  let touched=false;
  vm.runInNewContext(s.slice(a,b),{app,queryAdminDb:f.dbAll,console,mockUser:{},currentUser:async()=>{touched=true;throw Error('Wallet must not be touched')}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/cases/inactive/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,409);assert.equal(touched,false);
});
test('AC7 deposit-chain case cannot be opened through the paid case endpoint',async t=>{
  const f=await fixture(t);await f.dbRun("UPDATE cases SET exclusiveTo='DEPOSIT_CHAIN' WHERE id=1");
  const app=express();app.use(express.json());
  const s=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
  const a=s.indexOf("app.post(['/api/v1/cases/open'");const b=s.indexOf('// --- MOCK & ADMIN SYNCHRONIZED API ROUTES ---',a);
  let touched=false;
  vm.runInNewContext(s.slice(a,b),{app,queryAdminDb:f.dbAll,console,mockUser:{},currentUser:async()=>{touched=true;throw Error('Wallet must not be touched')}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/cases/active/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const body=await r.json();
  assert.equal(r.status,409);assert.equal(body.code,'CASE_EXCLUSIVE');assert.equal(touched,false);
});
test('AC8 public catalogue respects upgraderEnabled',async t=>{
  const f=await fixture(t),s=fs.readFileSync(path.resolve(__dirname,'../services/steamCatalog.js'),'utf8');
  const a=s.indexOf('async function queryItems('),b=s.indexOf('\nmodule.exports',a);
  const query=vm.runInNewContext(s.slice(a,b)+'\nqueryItems;',{
    openDb:()=>({close(){}}),ensureCatalogSchema:async()=>{},get:(_,sql,args)=>f.dbGet(sql,args),all:(_,sql,args)=>f.dbAll(sql,args)
  });
  assert.deepEqual(JSON.parse(JSON.stringify((await query({upgraderEnabled:true})).items.map(x=>x.id))),['db-1']);
});
test('AC9 RTP editor receives an object containing items',async t=>{
  const f=await fixture(t),r=await f.request('GET','/rtp/cases/1/tier/rtp_96');
  assert.equal(r.body.data.items[0].itemId,1);
});
test('AC6 import is idempotent and preserves item rows',async t=>{
  const f=await fixture(t);
  const r=await f.request('POST','/cases/items/import-upgrader',{priceMin:90,priceMax:90});
  assert.deepEqual(r.body.data,{imported:1,updated:0,total:1});
  assert.deepEqual((await f.request('POST','/cases/items/import-upgrader',{priceMin:90,priceMax:90})).body.data,{imported:0,updated:1,total:1});
  assert.equal((await f.dbGet('SELECT COUNT(*) n FROM items')).n,2);
});
test('AC10 bulk import reports actual created rows',async t=>{
  const f=await fixture(t),r=await f.request('POST','/cases/bulk',{cases:[{slug:'bulk',name:'Bulk',price:50,volatility:'AVERAGE',items:[{catalogItemName:'Alpha',chanceRtp96:100,rarity:'REGULAR',itemPrice:10}]}],archiveExistingSeries:false});
  assert.equal(r.body.data.createdActive,1);assert.equal(r.body.data.errors.length,0);
  const row=await f.dbGet("SELECT id FROM cases WHERE slug='bulk'");assert.ok(row);
});
test('AC10 unknown catalogue item returns an import error',async t=>{
  const f=await fixture(t),r=await f.request('POST','/cases/bulk',{cases:[{slug:'missing',name:'Missing',price:50,items:[{catalogItemName:'Not here',chanceRtp96:100,rarity:'REGULAR',itemPrice:10}]}]});
  assert.equal(r.body.data.errors.length,1);assert.equal(await f.dbGet("SELECT id FROM cases WHERE slug='missing'"),undefined);
});
test('AC11 unavailable limited supply never returns fabricated stock',async t=>{
  const f=await fixture(t),r=await f.request('GET','/cases/series/1/supply');assert.equal(r.status,501);
});
test('AC12 edited chance zero is stored instead of preserving old value',async t=>{
  const f=await fixture(t);await f.request('PUT','/cases/1',{items:[{id:1,chance:0,ticketRangeFrom:0,ticketRangeTo:0}]});
  assert.equal((await f.dbGet('SELECT chance FROM case_items WHERE case_id=1')).chance,0);
});
for(const [value,expected]of [[-1,400],[0,200],[1,200]])test(`AC13 item price boundary ${value}`,async t=>{
  const f=await fixture(t),r=await f.request('PUT','/cases/items/1',{price:value});assert.equal(r.status,expected);
});
test('AC13 item color follows project rarity tokens',async t=>{
  const f=await fixture(t);await f.request('PUT','/cases/items/1',{rarity:'UNUSUAL',color:'ffffff'});
  assert.equal((await f.dbGet('SELECT color FROM items WHERE id=1')).color,'4076ff');
});
test('AC14 case form sends composition instead of only IDs',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,'../admin.titanrust.ru/public/assets/CaseFormModal.vue_vue_type_script_setup_true_lang-84FjkQIS.js'),'utf8');
  assert.ok(s.includes('a=c.value.map(y=>({id:y.id,chance:y.chance,ticketRangeFrom:y.ticketRangeFrom,ticketRangeTo:y.ticketRangeTo}))'));
  assert.ok(!s.includes('u.editingCase&&await $t(),rt.invalidateQueries'));
});
test('AC15 market availability refresh does not undo admin deactivation',async t=>{
  const f=await fixture(t);await f.request('DELETE','/cases/items/2');await f.dbRun('UPDATE items SET delisted=0 WHERE id=2');
  const r=await f.request('GET','/cases/items?ids[]=2');assert.equal(r.body.data.length,0);
});
test('AC16 invalid page JSON is not converted to empty object',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,'../admin.titanrust.ru/public/assets/PagesListPage-DAmzDkL1.js'),'utf8');
  assert.ok(!s.includes('catch{o={}}'));
});
test('AC17 catalogue does not silently discard a custom item price',async t=>{
  const f=await fixture(t),r=await f.request('POST','/cases/from-catalog',{name:'Custom',slug:'custom',price:50,items:[{catalogItemId:1,customPrice:999,chance:100}]});
  assert.equal(r.status,400);assert.equal(await f.dbGet("SELECT id FROM cases WHERE slug='custom'"),undefined);
});

test('AC18 editing a limited case does not call the unavailable supply endpoint',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,'../admin.titanrust.ru/public/assets/CaseFormModal.vue_vue_type_script_setup_true_lang-84FjkQIS.js'),'utf8');
  const start=s.indexOf('async function Kt()'),end=s.indexOf('return(t,e)=>',start);
  assert.ok(start>=0&&end>start,'case submit function must be present in the compiled bundle');
  assert.ok(!s.slice(start,end).includes('Ht.mutateAsync'),
    'ordinary case save must not call the intentionally unsupported limited-supply API');
});

/*
 * Собранные чанки правятся вручную — исходников Vue в репозитории нет. В
 * минифицированном файле всё лежит одной строкой, поэтому автоподстановка
 * точки с запятой не спасает: `_.warning("…")const n=…` — синтаксическая
 * ошибка, чанк перестаёт разбираться целиком, и форма кейса не открывается.
 * Ровно так и произошло с правкой про тираж. Разбор проверяется отдельно,
 * потому что проверка «нужный вызов удалён» такую поломку не замечает.
 */
test('AC19 вручную правленые чанки админки разбираются', () => {
  const chunks = [
    'CaseFormModal.vue_vue_type_script_setup_true_lang-84FjkQIS.js',
    'index-D4siiPNB.js',
    'BattlesListPage-C95vn4AY.js'
  ];
  for (const chunk of chunks) {
    const source = path.resolve(__dirname, '../admin.titanrust.ru/public/assets', chunk);
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-')), 'chunk.mjs');
    fs.copyFileSync(source, copy);
    const check = require('node:child_process').spawnSync(process.execPath, ['--check', copy], {encoding: 'utf8'});
    assert.equal(check.status, 0, `${chunk} не разбирается: ${String(check.stderr).split('\n').find(l => /Error/.test(l)) || ''}`);
  }
});

test('AC20 выбор серии использует один строковый тип идентификатора', () => {
  const s=fs.readFileSync(path.resolve(__dirname,'../admin.titanrust.ru/public/assets/CaseFormModal.vue_vue_type_script_setup_true_lang-84FjkQIS.js'),'utf8');
  assert.ok(s.includes('value:String(a.id)'),
    'значение пункта серии должно совпадать со строковым model-value компонента Select');
  assert.ok(s.includes('String(t.id)===String(R.value)'),
    'выбранная серия должна находиться независимо от числового типа id в API');
  assert.ok(s.includes('R.value=u.editingCase.seriesId==null?"":String(u.editingCase.seriesId)'),
    'при редактировании seriesId должен нормализоваться до типа Select');
});
