'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {createRequire}=require('node:module');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
const express=require('../admin.titanrust.ru/server/node_modules/express');
/* test_strategy:
 * artifact: header online stats
 * rationale: Actual compiled consumer expects data.stats.online; Gate 0 OFF.
 * criticality: MEDIUM
 * selected_types:
 *   - rationale: Exercise admin setting persistence through the public HTTP response.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [SQLite memory, Express localhost, actual route registration]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: Gate 1 formatting covered by response assertions.
 *     type: unit
 *   - reason: Gate 3 non-critical header; compiled markup tested directly.
 *     type: e2e
 *   - reason: Gate 4 same deploy.
 *     type: contract
 *   - reason: Gate 6 finite cases and numeric boundaries suffice.
 *     type: property-based
 * deliberately_skipped:
 *   - why: Deployment not authorized or available in this environment.
 *     what: Gate 5 production write smoke
 */
test('online uses the admin base with the compiled header response shape',async t=>{
  const db=new sqlite.Database(':memory:');
  const query=(sql,p=[])=>new Promise((yes,no)=>db.all(sql,p,(e,r)=>e?no(e):yes(r)));
  for(const sql of [
    'CREATE TABLE transactions(user_id INTEGER,type TEXT,created_at TEXT)',
    "INSERT INTO transactions VALUES(1,'case_open',datetime('now')),(1,'upgrade',datetime('now')),(2,'case_open','2099-01-01T00:00:00Z')",
    'CREATE TABLE users(id INTEGER)', 'INSERT INTO users VALUES(1),(2)',
    'CREATE TABLE battles(status TEXT)',
    'CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)'
  ])await query(sql);
  const app=express();app.use(express.json());
  require('../admin.titanrust.ru/server/adminRoutes').makeAdminRoutes({app,dbAll:query,dbGet:async(s,p)=>(await query(s,p))[0],dbRun:query,requireAdminJWT:(req,res,next)=>next()});
  const file=path.resolve(__dirname,'../server.js'),source=fs.readFileSync(file,'utf8');
  const start=source.indexOf("app.get(['/api/v1/stats/global'");
  const end=source.indexOf('// Deposit chain state',start);
  const context={app,queryAdminDb:query,cached:async(k,ttl,fn)=>fn(),process:{env:{BASE_ONLINE:'100'}},console,require:createRequire(file)};
  const declaration=source.split('\n').find(line=>line.startsWith('const globalStats = '));
  if(declaration)vm.runInNewContext(declaration+'\n'+source.slice(start,end),context);
  else vm.runInNewContext(source.slice(start,end),context);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const base of [79,0,10000]){
    const saved=await fetch(origin+'/api/v1/admin/bots/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({onlineSim:{baseCount:base},personas:{activeBots:10}})});
    assert.equal(saved.status,200);
    const body=await(await fetch(origin+'/api/v1/stats/global')).json();
    assert.equal(body.data.stats?.online,base+1);
    assert.equal(body.data.onlineCount,base+1);
    assert.equal(body.data.stats.totalUsers,2);
  }
});
test('desktop header includes the requested SATHCEL text beside its mark',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../public/assets/js/bottom-bar-DySVlKhO.js'),'utf8');
  assert.ok(source.includes('header-wordmark'));
  const start=source.indexOf('o("span",{class:"header-wordmark"');
  const end=source.indexOf(',t[3]',start);
  const expression=source.slice(start,end-1);
  // Execute the exact compiled static vnode; this is not a separate mock logo.
  const node=vm.runInNewContext(expression,{o:(tag,props,children)=>({tag,props,children})});
  assert.equal(node.children[1].children,'SATHCEL');
  assert.equal(node.children[0].props.src,'/brand/logo-mark.svg');
});
test('online updates use the event consumed by the open header',async()=>{
  const {makeGlobalStats}=require('../services/globalStats');
  const stats=makeGlobalStats({queryAdminDb:async sql=>sql.includes('SELECT value')?[{value:'{"onlineSim":{"baseCount":79}}'}]:[{v:1}]});
  const messages=[];
  await stats.publish({clients:new Set([{readyState:1,send:x=>messages.push(JSON.parse(x))},{readyState:3,send:()=>assert.fail('closed socket')}])});
  assert.equal(messages.length,1);assert.equal(messages[0].event,'stats:updated');assert.equal(messages[0].data.online,80);
});
