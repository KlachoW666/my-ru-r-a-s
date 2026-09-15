'use strict';
/* test_strategy:
 * artifact: daily top drops
 * rationale: Read persisted game results rather than a mock; Gate 0 OFF.
 * criticality: MEDIUM-HIGH
 * selected_types:
 *   - rationale: Real SQLite covers date comparisons, joins and persisted wins.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [sqlite3, temporary filesystem]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: Gate 1 formatting exercised through service results.
 *     type: unit
 *   - reason: Gate 4 bundle and server ship together.
 *     type: contract
 *   - reason: Gate 6 finite modes and date boundary tables suffice.
 *     type: property-based
 * deliberately_skipped:
 *   - why: No production game mutations; UI smoke is performed separately.
 *     what: Real-money e2e
 */
const test=require('node:test'),assert=require('node:assert/strict');
const sqlite=require('../admin.titanrust.ru/server/node_modules/sqlite3');
async function fixture(t){
 const db=new sqlite.Database(':memory:');t.after(()=>new Promise(r=>db.close(r)));
 const query=(sql,p=[])=>new Promise((r,j)=>db.all(sql,p,(e,rows)=>e?j(e):r(rows)));
 for(const sql of [
  'CREATE TABLE users(id INTEGER,username TEXT,avatar TEXT)',
  'CREATE TABLE cases(id INTEGER,slug TEXT,name TEXT,price REAL,image TEXT,archived INTEGER)',
  'CREATE TABLE items(id INTEGER,name TEXT,image TEXT,rarity TEXT)',
  'CREATE TABLE inventory(id INTEGER,user_id TEXT,name TEXT,image TEXT,price REAL,rarity TEXT,source TEXT,source_ref TEXT,status TEXT,created_at TEXT)',
  'CREATE TABLE transactions(id INTEGER,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT)',
  'CREATE TABLE battles(uid TEXT,max_players INTEGER,rounds INTEGER,total_price REAL,status TEXT,is_private INTEGER)',
  'CREATE TABLE upgrade_battles(uid TEXT,round_bet_cents INTEGER,status TEXT)',
  "INSERT INTO users VALUES(1,'One','/one.png'),(2,'Two','/two.png')",
  "INSERT INTO cases VALUES(1,'farm','Farm',99,'/case.png',0)",
  "INSERT INTO transactions VALUES(1,1,'case_open',-198,'Открытие: farm x2','2026-09-14 10:00:00')",
  "INSERT INTO inventory VALUES(1,'1','Skin','/skin.png',161.42,'RARE','case','farm','sold','2026-09-14 10:00:00'),(2,'1','Other','/other.png',250,'RARE','case','farm','sold','2026-09-14 10:00:00'),(3,'2','Old','/old.png',9999,'GOLD','case','farm','owned','2026-09-13 23:59:59')"
 ])await query(sql);
 const {makeTopDropsService}=require('../services/topDrops');
 return {query,service:makeTopDropsService({queryAdminDb:query,fixImageUrl:x=>x,mapRarity:x=>x,now:()=>Date.parse('2026-09-14T12:00:00Z')})};
}
test('daily board returns the best persisted drop per user',async t=>{
 const {service}=await fixture(t);const r=await service.board('cases');
 assert.equal(r.entries.length,1);assert.equal(r.entries[0].itemName,'Other');
 assert.equal(r.entries[0].metricDisplay,'2.53');assert.equal(r.entries[0].prizeValue,'250.00');
 assert.equal(r.entries[0].rank,1);assert.equal(r.dayUtc,'2026-09-14');
});
test('personal result uses the same ranking as public board',async t=>{
 const {service}=await fixture(t);const r=await service.me('cases',1);
 assert.equal(r.hasEntry,true);assert.deepEqual(r.entry,(await service.board('cases')).entries[0]);
 assert.equal((await service.me('cases',2)).hasEntry,false);
});
for(const [date,expected] of [['2026-09-13 23:59:59',false],['2026-09-14 00:00:00',true],['2026-09-14T00:00:01Z',true]])
 test(`03:00 MSK reset includes ${date}: ${expected}`,async t=>{const {service,query}=await fixture(t);await query('UPDATE inventory SET created_at=? WHERE id=3',[date]);assert.equal((await service.me('cases',2)).hasEntry,expected);});
test('unavailable database is an error, not an empty top',async()=>{
 const {makeTopDropsService}=require('../services/topDrops');
 const service=makeTopDropsService({queryAdminDb:async()=>Object.assign([],{failed:true})});
 await assert.rejects(service.board('cases'),/недоступ/i);
});
test('upgrader board reads committed wins with their actual stake',async t=>{
 const {query,service}=await fixture(t);
 await query("INSERT INTO items VALUES(1,'Upgrade skin','/upgrade.png','VIOLET')");
 await query("INSERT INTO transactions VALUES(5,1,'upgrade',-100,'Апгрейд x5','2026-09-14 11:00:00'),(6,1,'upgrade_win',500,'Upgrade skin','2026-09-14 11:00:00')");
 const r=await service.board('upgrader');assert.equal(r.entries[0].metricDisplay,'5.00');assert.equal(r.entries[0].itemImage,'/upgrade.png');
});
test('battle board ranks actual payouts from finished public battles',async t=>{
 const {query,service}=await fixture(t);
 await query("INSERT INTO battles VALUES('b1',3,4,99,'finished',0),('private',2,2,100,'finished',1)");
 await query("INSERT INTO transactions VALUES(7,1,'battle_win',297,'Кейс-батл b1','2026-09-14 11:00:00'),(8,2,'battle_win',9999,'Кейс-батл private','2026-09-14 11:00:00')");
 const r=await service.board('battles');assert.equal(r.entries.length,1);assert.equal(r.entries[0].metricDisplay,'297.00');assert.equal(r.entries[0].stakeValue,'99.00');assert.equal(r.entries[0].playersCount,3);
});
test('live feed comes from the same persisted drops after restart',async t=>{
 const {service}=await fixture(t);const r=await service.recent('live',10);
 assert.equal(r.length,2);assert.ok(r.every(x=>x.userId===1&&x.eventType==='CASE'));assert.equal(r[0].itemName,'Other');
});

test('privacy preference excludes player from public board and live feed',async t=>{
 const {query,service}=await fixture(t);
 await query('ALTER TABLE users ADD COLUMN hidden_from_public_tops INTEGER DEFAULT 0');
 await query('UPDATE users SET hidden_from_public_tops=1 WHERE id=1');
 assert.equal((await service.board('cases')).entries.length,0);
 assert.equal((await service.recent('live',10)).length,0);
 assert.equal((await service.me('cases',1)).hiddenFromPublicTops,true);
});
