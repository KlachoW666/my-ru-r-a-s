'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('../admin.titanrust.ru/server/node_modules/express');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
/*
test_strategy:
  artifact: Games and RTP admin API
  rationale: Compiled UI contracts differ from SQLite responses and POST validation is missing.
  criticality: HIGH
  selected_types:
    - rationale: Real HTTP and SQLite expose DTO, filtering and atomic mutation failures (Gate 1 covered here).
      type: integration
      size: medium
      framework: node:test
      dependencies: [Express, temporary SQLite]
      gate: Gate 2
  rejected_types:
    - reason: Pure validation branches covered through HTTP; no repository mocks.
      type: unit
    - reason: Internal admin screen; compiled components have no source (Gate 3).
      type: component
    - reason: Consumer ships with provider (Gate 4).
      type: contract
    - reason: Existing distribution algorithm unchanged; deterministic seed examples cover job orchestration (Gate 6).
      type: property-based
  deliberately_skipped:
    - why: No deployment performed (Gate 5).
      what: Production smoke.
    - why: Requires user Passkey login.
      what: Authenticated browser E2E; not claimed verified.
Test Cases to Cover:
- [integration] AC1 game modes list, update shape, persistence, invalid input.
- [integration] AC2 tiers expose real percentage fractions; bulk assignment validates users and audits changes.
- [integration] AC3 historical stats are arrays, date/mechanic filters work, unknown historical tier is explicit.
- [integration] AC4 simulation uses real probabilities, reproducible seed, empty case fails, cancel is terminal.
- [integration] AC5 missing jobs and invalid iterations fail explicitly, protected requests do not run.
*/
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-rtp-'));
  const DB_PATH = path.join(dir, 'test.sqlite');
  const db = new sqlite.Database(DB_PATH);
  const dbRun = (s, p = []) => new Promise((ok, no) => db.run(s, p, function(e) { e ? no(e) : ok({ changes: this.changes, lastID: this.lastID }); }));
  const dbAll = (s, p = []) => new Promise((ok, no) => db.all(s, p, (e, r) => e ? no(e) : ok(r)));
  const dbGet = async(s, p) => (await dbAll(s, p))[0];
  for (const s of [
    `CREATE TABLE game_configs(id TEXT PRIMARY KEY,name TEXT,enabled INTEGER,min_bet REAL,max_bet REAL,house_edge REAL)`,
    `INSERT INTO game_configs VALUES('cases','Cases',1,10,50000,5),('upgrader','Upgrade',1,10,50000,5)`,
    `CREATE TABLE cases(id INTEGER PRIMARY KEY,slug TEXT,name TEXT,price REAL,isActive INTEGER,status TEXT,archived INTEGER)`,
    `INSERT INTO cases VALUES(1,'alpha','Alpha',50,1,'active',0),(2,'empty','Empty',50,0,'inactive',0)`,
    `CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,price REAL,delisted INTEGER DEFAULT 0,admin_disabled INTEGER DEFAULT 0)`,
    `INSERT INTO items(id,name,price) VALUES(1,'Small',10),(2,'Large',90)`,
    `CREATE TABLE case_items(case_id INTEGER,item_id INTEGER,chance REAL,ticketRangeFrom INTEGER,ticketRangeTo INTEGER)`,
    `INSERT INTO case_items VALUES(1,1,50,0,0),(1,2,50,0,0)`,
    `CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,rtp REAL,balance REAL)`,
    `INSERT INTO users VALUES(1,'Alice',95,1000),(2,'Bob',95,1000)`,
    `CREATE TABLE rtp_tiers(id INTEGER PRIMARY KEY,name TEXT,rtp REAL,priority INTEGER,active INTEGER)`,
    `INSERT INTO rtp_tiers VALUES(1,'Normal',95,0,1),(2,'Other',97,1,1)`,
    `CREATE TABLE rtp_assignments(id INTEGER PRIMARY KEY,user_id TEXT UNIQUE,tier_id INTEGER,rtp_override REAL,assigned_by TEXT,assigned_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,created_at TEXT)`,
    `INSERT INTO transactions VALUES(1,1,'case_open',-100,'2026-09-01 10:00:00'),(2,1,'case_win',60,'2026-09-01 10:00:00'),(3,1,'upgrade',-20,'2026-08-01 10:00:00')`
  ]) await dbRun(s);
  const app = express(); app.use(express.json());
  const requireAdminJWT = (req, res, next) => {
    if (req.headers['x-deny']) return res.status(403).json({ success: false });
    req.user = { id: 'admin-test', username: 'Admin' }; next();
  };
  const filename = path.resolve(__dirname, '../admin.titanrust.ru/server/server.js');
  const source = fs.readFileSync(filename, 'utf8');
  const line = source.split('\n').find(l => l.includes("require('./gamesRtpRoutes').register"));
  if (line) vm.runInNewContext(line, { app, DB_PATH, dbRun, dbAll, dbGet, requireAdminJWT, require: createRequire(filename) });
  require('../admin.titanrust.ru/server/adminRoutes').makeAdminRoutes({ app, dbRun, dbAll, dbGet, requireAdminJWT });
  app.all('/api/v1/admin/*', (req,res) => res.json({ success:true,data:[],catchAll:true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async() => { await new Promise(r => server.close(r)); await new Promise(r => db.close(r)); fs.unlinkSync(DB_PATH); fs.rmdirSync(dir); });
  const request = async(method, url, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin${url}`, { method, headers: { 'Content-Type':'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status:r.status, body:await r.json() };
  };
  const job = async(body) => {
    const start = await request('POST','/rtp/validate',body);
    assert.equal(start.status,200,JSON.stringify(start.body)); assert.ok(start.body.data.jobId);
    for(let n=0;n<500;n++) {
      const r = await request('GET','/rtp/jobs/'+start.body.data.jobId);
      if(['done','error'].includes(r.body.data.status)) return r.body.data;
      await new Promise(r=>setTimeout(r,5));
    }
    assert.fail('Job did not finish');
  };
  return { request, dbGet, dbAll, dbRun, job };
}
test('AC1 game config returns modes consumed by the bundle',async t=>{
  const f=await fixture(t);const r=await f.request('GET','/config/games');
  assert.equal(r.body.data.modes[0].name,'cases');assert.equal(r.body.data.modes[0].enabled,true);
  assert.deepEqual(r.body.data.caseStates,{totalActive:1,totalInactive:1});
});
test('AC1 game config update persists description and returns refreshed list',async t=>{
  const f=await fixture(t);const r=await f.request('PUT','/config/games/cases',{enabled:false,description:'Maintenance'});
  assert.equal(r.status,200);assert.equal(r.body.data.modes[0].description,'Maintenance');
  assert.equal((await f.dbGet("SELECT enabled FROM game_configs WHERE id='cases'")).enabled,0);
  assert.equal((await f.request('GET','/config/games')).body.data.modes[0].description,'Maintenance');
});
test('AC1 invalid enabled value cannot turn a game on',async t=>{
  const f=await fixture(t);assert.equal((await f.request('PUT','/config/games/cases',{enabled:'false'})).status,400);
});
test('AC2 tiers match fractional UI contract',async t=>{
  const f=await fixture(t);const r=await f.request('GET','/rtp/tiers');
  assert.equal(r.body.data[0].code,'rtp_95');assert.equal(r.body.data[0].targetRtp,.95);assert.equal(r.body.data[0].assignedUserCount,2);
});
test('AC2 CSV assignment validates each user and persists real RTP',async t=>{
  const f=await fixture(t);const r=await f.request('POST','/rtp/users/bulk',{sourceLabel:'test.csv',assignments:[{userId:'1',targetCode:'rtp_97'},{userId:'missing',targetCode:'rtp_97'}]});
  assert.equal(r.status,200);assert.equal(r.body.data.appliedCount,1);assert.equal(r.body.data.errors.length,1);
  assert.equal((await f.dbGet('SELECT rtp FROM users WHERE id=1')).rtp,97);
  assert.equal((await f.dbGet('SELECT balance FROM users WHERE id=1')).balance,1000);
});
test('AC3 stats filter ISO dates without guessing historical tiers',async t=>{
  const f=await fixture(t);const r=await f.request('GET','/rtp/stats?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z&mechanics[]=CASE_OPENING');
  assert.ok(Array.isArray(r.body.data));assert.equal(r.body.data.length,1);
  assert.equal(r.body.data[0].tierCode,'legacy_unknown');assert.equal(Number(r.body.data[0].actualRtp),.6);
  assert.equal(r.body.data[0].betCount,1);
});
test('AC4 validation uses configured chances rather than fabricated target',async t=>{
  const f=await fixture(t);const body={mechanic:'CASE_OPENING',tier:'rtp_95',caseId:'1',iterations:1000,seedServer:'test-server',seedClient:'test-client'};
  const a=await f.job(body);assert.equal(a.status,'done');assert.equal(Number(a.result.arithmeticRtp),1);
  assert.equal(a.result.seedUsed.client,'test-client');
  const b=await f.job(body);assert.equal(a.result.empiricalRtp,b.result.empiricalRtp);
});
test('AC4 empty composition reports an actionable error',async t=>{
  const f=await fixture(t);const r=await f.request('POST','/rtp/validate',{mechanic:'CASE_OPENING',tier:'rtp_95',caseId:'2',iterations:1000});
  assert.equal(r.status,409);assert.match(r.body.message,/состав/i);
});
test('AC5 unknown job is 404 instead of success catchall',async t=>{
  const f=await fixture(t);assert.equal((await f.request('GET','/rtp/jobs/absent')).status,404);
});
for(const iterations of [0,999,100000001])test('AC5 iterations boundary '+iterations,async t=>{
  const f=await fixture(t);assert.equal((await f.request('POST','/rtp/validate',{mechanic:'CASE_OPENING',tier:'rtp_95',caseId:'1',iterations})).status,400);
});
test('AC5 protected validation refuses unauthorized requests',async t=>{
  const f=await fixture(t);assert.equal((await f.request('POST','/rtp/validate',{}, {'x-deny':'1'})).status,403);
});
test('AC4 cancel leaves a terminal job state',async t=>{
  const f=await fixture(t);const start=await f.request('POST','/rtp/validate',{mechanic:'CASE_OPENING',tier:'rtp_95',caseId:'1',iterations:100000000});
  assert.ok(start.body.data.jobId);
  const url='/rtp/jobs/'+start.body.data.jobId;
  assert.equal((await f.request('DELETE',url)).body.data.status,'error');
  assert.match((await f.request('GET',url)).body.data.error,/отменена/);
});
test('AC4 upgrader validation uses actual global RTP',async t=>{
  const f=await fixture(t);const job=await f.job({mechanic:'UPGRADER',tier:'rtp_97',iterations:1001,bet:'10',totalItemsValue:'100',seedServer:'s',seedClient:'c'});
  assert.equal(job.status,'done');assert.ok(Math.abs(job.result.arithmeticRtp-.95)<1e-10);assert.equal(job.result.targetRtp,.97);
});
test('AC6 disabling mode stops site POST before game handler',async t=>{
  const f=await fixture(t);let played=0;
  const app=express();
  const source=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
  const registration=source.split('\n').find(l=>l.includes("require('./services/gameAccess').register"));
  if(registration)vm.runInNewContext(registration,{app,queryAdminDb:f.dbAll,require:createRequire(path.resolve(__dirname,'../server.js'))});
  app.post('/api/v1/cases/open',(req,res)=>{played++;res.json({status:'success'});});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  await f.request('PUT','/config/games/cases',{enabled:false,description:'Stop'});
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/cases/open`,{method:'POST'});
  assert.equal(r.status,409);assert.equal(played,0);
  await f.request('PUT','/config/games/cases',{enabled:true,description:'Run'});
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/v1/cases/open`,{method:'POST'})).status,200);
});
test('AC7 validation selects a tier that actually exists',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,'../admin.titanrust.ru/public/assets/RtpValidationPage-Dacz4YcV.js'),'utf8');
  assert.ok(s.includes('z(te,'),'Loaded tiers must replace the hardcoded rtp_96 selection');
});
test('AC2 individual tier update exposes an audit record',async t=>{
  const f=await fixture(t);
  const updated=await f.request('PUT','/rtp/users/1/tier',{targetCode:'rtp_97',reason:'Support review'});
  assert.equal(updated.status,200);assert.equal(updated.body.data.tier.code,'rtp_97');
  assert.equal((await f.request('GET','/rtp/users/1/tier')).body.data.tier.code,'rtp_97');
  const audit=(await f.request('GET','/rtp/users/1/tier/audit')).body.data;
  assert.equal(audit[0].oldTierCode,'rtp_95');assert.equal(audit[0].reason,'Support review');
  const reset=await f.request('POST','/rtp/users/1/tier/reset',{reason:'Reset'});
  assert.equal(reset.body.data.tier.code,'rtp_95');
});
test('AC2 invalid individual tier assignment leaves RTP unchanged',async t=>{
  const f=await fixture(t);const r=await f.request('PUT','/rtp/users/1/tier',{targetCode:'rtp_404',reason:'Mistake'});
  assert.equal(r.status,400);assert.equal((await f.dbGet('SELECT rtp FROM users WHERE id=1')).rtp,95);
});
test('AC8 battle list uses real status, participants and pagination',async t=>{
  const f=await fixture(t);
  await f.dbRun('CREATE TABLE battles(id INTEGER PRIMARY KEY,uid TEXT,status TEXT,max_players INTEGER,total_price REAL,creator_id TEXT,created_at TEXT)');
  await f.dbRun('CREATE TABLE battle_players(battle_id INTEGER,user_id TEXT)');
  await f.dbRun("INSERT INTO battles VALUES(1,'live','waiting',2,50,'1','2026-09-01 10:00:00'),(2,'done','finished',2,100,'2','2026-09-01 09:00:00')");
  await f.dbRun("INSERT INTO battle_players VALUES(1,'1'),(2,'1'),(2,'2')");
  const r=await f.request('GET','/battles?status=PENDING&page=1&limit=1');
  assert.equal(r.body.data.items[0].battleId,'live');assert.equal(r.body.data.items[0].participantCount,1);
  assert.equal(r.body.data.items[0].totalPot,50);assert.equal(r.body.data.pagination.total,1);
});
