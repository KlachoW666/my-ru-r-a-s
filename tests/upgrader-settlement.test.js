'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
const {makeUpgraderSettlement}=require('../services/upgraderSettlement');

/* test_strategy:
 * artifact: ordinary upgrader balance settlement
 * rationale: A win must return the selected target value once, not return the stake and then add the target again.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Balance and ledger rows must commit in one real SQLite transaction.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [temporary SQLite]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: The risk is server accounting, not rendering.
 *     type: component
 *   - reason: No production account should be charged for verification.
 *     type: e2e
 */

async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'satchel-upgrader-'));
 const file=path.join(dir,'db.sqlite');
 const getDb=()=>new sqlite.Database(file);
 const run=(sql,params=[])=>new Promise((resolve,reject)=>{const db=getDb();db.run(sql,params,function(error){db.close(()=>error?reject(error):resolve(this));});});
 const all=(sql,params=[])=>new Promise((resolve,reject)=>{const db=getDb();db.all(sql,params,(error,rows)=>db.close(()=>error?reject(error):resolve(rows)));});
 await run('CREATE TABLE users(id INTEGER PRIMARY KEY,balance REAL NOT NULL)');
 await run('INSERT INTO users VALUES(1,350000)');
 t.after(()=>{if(fs.existsSync(file))fs.unlinkSync(file);if(fs.existsSync(dir))fs.rmdirSync(dir);});
 return {service:makeUpgraderSettlement({getDb}),all,run};
}

test('100000 stake with a 130000 target changes balance by exactly +30000',async t=>{
 const {service,all}=await fixture(t);
 const result=await service.settle({userId:1,betAmount:100000,winAmount:130000,multiplier:1.3,itemName:'Target'});
 assert.equal(result.balance,380000);
 assert.deepEqual((await all('SELECT type,amount FROM transactions ORDER BY id')).map(row=>[row.type,row.amount]),[
  ['upgrade',-100000],['upgrade_win',130000]
 ]);
});

test('a failed ledger insert rolls the balance back',async t=>{
 const {service,all,run}=await fixture(t);
 await run("CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT CHECK(type='never'),amount REAL,comment TEXT,created_at TEXT)");
 await assert.rejects(()=>service.settle({userId:1,betAmount:100000,winAmount:130000,multiplier:1.3,itemName:'Target'}));
 assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance,350000);
});
