'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
const {toPublicUser}=require('../services/auth');
const {makeInventoryService}=require('../services/inventory');

/* test_strategy:
 * artifact: public profile API contract and game history
 * rationale: The authenticated profile is blank because its compiled consumer and API use different field names, while history crosses SQLite and HTTP boundaries.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Public-user field aliases are deterministic DTO logic; equivalence partitions cover Steam and email identities.
 *     type: unit
 *     size: small
 *     framework: node:test
 *     dependencies: []
 *     gate: Gate 1
 *   - rationale: Stats and history must be derived from real persisted ledger and inventory rows without mocks.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [temporary SQLite]
 *     gate: Gate 2
 *   - rationale: The bundled SPA is a distinct consumer of the response field names and pagination envelope.
 *     type: contract
 *     size: small
 *     framework: node:test
 *     dependencies: [compiled frontend bundle]
 *     gate: Gate 4
 * rejected_types:
 *   - reason: The UI component itself is already compiled; the contract boundary gives a less brittle signal than DOM snapshots.
 *     type: component
 *   - reason: A real paid account must not be mutated merely to verify profile reads.
 *     type: e2e
 *   - reason: Production authentication secrets are unavailable and a local HTTP check is covered by the final smoke pass.
 *     type: smoke
 *   - reason: Ledger types and pagination limits are bounded and covered by table examples plus BVA.
 *     type: property-based
 * deliberately_skipped:
 *   - why: It could expose or alter a real player's private data.
 *     what: Production authenticated profile test
 */

async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'satchel-profile-'));
 const file=path.join(dir,'profile.sqlite');
 const open=()=>new sqlite.Database(file);
 const all=(sql,params=[])=>new Promise((resolve,reject)=>{const db=open();db.all(sql,params,(error,rows)=>db.close(()=>error?reject(error):resolve(rows)));});
 const run=(sql,params=[])=>new Promise((resolve,reject)=>{const db=open();db.run(sql,params,function(error){const result={lastID:this.lastID,changes:this.changes};db.close(()=>error?reject(error):resolve(result));});});
 await run('CREATE TABLE users(id INTEGER PRIMARY KEY, balance REAL)');
 await run('INSERT INTO users VALUES(7,1000)');
 await run('CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT)');
 await run("INSERT INTO transactions VALUES(1,7,'case_open',-400,'Открытие: farm ak x4','2026-09-04 10:00:00')");
 await run("INSERT INTO transactions VALUES(2,7,'upgrade',-100,'Апгрейд x1.30','2026-09-04 11:00:00')");
 await run("INSERT INTO transactions VALUES(3,7,'upgrade_win',130,'Frost Wolf','2026-09-04 11:00:00')");
 await run("INSERT INTO transactions VALUES(4,7,'battle_entry',-50,'Батл room-1','2026-09-04 12:00:00')");
 await run("INSERT INTO transactions VALUES(5,7,'battle_win',80,'Батл room-1','2026-09-04 12:00:00')");
 await run("INSERT INTO transactions VALUES(6,7,'upgrade',-200,'Апгрейд x1.30','2026-09-04 11:00:00')");
 await run("INSERT INTO transactions VALUES(7,7,'upgrade_win',260,'Tempered AK','2026-09-04 11:00:00')");
 const queryAdminDb=async(sql,params=[])=>all(sql,params);
 const inventory=makeInventoryService({queryAdminDb,getAdminDb:open,adjustBalanceById:async()=>{},recordTransactionById:async()=>{},fixImageUrl:value=>value});
 await inventory.ensureSchema();
 for(let id=1;id<=4;id++)await run("INSERT INTO inventory(id,user_id,name,image,price,rarity,source,source_ref,status,created_at) VALUES(?,7,?,?,?,'REGULAR','case','farm ak','owned','2026-09-04 10:00:00')",[id,`Drop ${id}`,`/${id}.webp`,100+id]);
 t.after(()=>{if(fs.existsSync(file))fs.unlinkSync(file);if(fs.existsSync(dir))fs.rmdirSync(dir);});
 return inventory;
}

test('public user exposes the field names consumed by the profile bundle',()=>{
 const user=toPublicUser({id:7,username:'Sathcel Player',steam_id:'76561198000000007',balance:123.45,role:'user',status:'active',email:'player@example.test',email_verified:1,trade_link:'https://steamcommunity.com/tradeoffer/new/?partner=7&token=test'});
 assert.equal(user.userId,'7');
 assert.equal(user.publicId,'7');
 assert.equal(user.displayName,'Sathcel Player');
 assert.equal(user.tradeUrl,'https://steamcommunity.com/tradeoffer/new/?partner=7&token=test');
 assert.deepEqual(user.linkedProviders,['steam','email']);
 assert.equal(user.emailVerified,true);
});

test('profile stats count every case in a batch',async t=>{
 const inventory=await fixture(t);
 const stats=await inventory.userStats(7);
 assert.equal(stats.totalCases,4);
 assert.equal(stats.totalUpgrades,2);
 assert.equal(stats.totalBattles,1);
 assert.equal(stats.bestDropItemName,'Drop 4');
 assert.equal(stats.bestDropItemPrice,104);
});

test('case history returns persisted drops with pagination',async t=>{
 const inventory=await fixture(t);
 assert.equal(typeof inventory.gameHistory,'function');
 const history=await inventory.gameHistory(7,{type:'case',page:1,limit:6});
 assert.equal(history.total,1);
 assert.equal(history.page,1);
 assert.equal(history.limit,6);
 assert.equal(history.items[0].betAmount,400);
 assert.equal(history.items[0].itemsWon.length,4);
 assert.equal(history.items[0].winAmount,410);
 assert.equal(history.items[0].isWin,true);
});

test('upgrade history pairs one stake with one payout',async t=>{
 const inventory=await fixture(t);
 assert.equal(typeof inventory.gameHistory,'function');
 const history=await inventory.gameHistory(7,{type:'upgrader',page:1,limit:6});
 assert.equal(history.total,2);
 assert.deepEqual(history.items.map(item=>({bet:item.betAmount,win:item.winAmount,multiplier:item.multiplier})),[
  {bet:200,win:260,multiplier:1.3},
  {bet:100,win:130,multiplier:1.3}
 ]);
});

test('server owns a history route before the generic fallback',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
 const route=source.indexOf("app.get('/api/v1/history'");
 const fallback=source.indexOf("app.all('/api/v1/*'");
 assert.ok(route>=0,'GET /api/v1/history is missing');
 assert.ok(fallback<0||route<fallback,'history route must be registered before the generic fallback');
});
