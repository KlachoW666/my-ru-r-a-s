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

/* test_strategy:
 * artifact: admin user HTTP routes
 * rationale: The deployed bundle needs userId, nested user/wallet and pagination.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Real SQLite and Express expose missing handlers and DTO drift; Gate 0 OFF.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [sqlite3 in-memory, express localhost]
 *     gate: Gate 2
 *   - rationale: Verify the reported blank profile in the actual browser.
 *     type: smoke
 *     size: large
 *     framework: browser skill
 *     dependencies: [local admin server]
 *     gate: Gate 5
 * rejected_types:
 *   - reason: Gate 1 ON, but transformation covered through HTTP; no duplicate unit suite.
 *     type: unit
 *   - reason: Gate 3 OFF for an internal screen; browser smoke covers rendering.
 *     type: component
 *   - reason: Gate 3 OFF; mutation E2E on real user data is inappropriate.
 *     type: e2e
 *   - reason: Gate 4 OFF; single bundled consumer, no Pact broker needed.
 *     type: contract
 *   - reason: Gate 6 considered; EP and boundary examples suffice for this adapter.
 *     type: property-based
 * deliberately_skipped:
 *   - why: Do not modify actual balances or identities during verification.
 *     what: Production mutation smoke tests
 */

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-users-'));
  const DB_PATH = path.join(dir, 'test.sqlite');
  const db = new sqlite.Database(DB_PATH);
  const dbRun = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) {
    err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
  }));
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
  const dbGet = async (sql, params) => (await dbAll(sql, params))[0];
  await dbRun(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, steam_id TEXT, role TEXT, status TEXT,
    balance REAL, created_at TEXT, last_login_at TEXT, email TEXT, email_verified INTEGER, avatar TEXT,
    profile_url TEXT, trade_link TEXT, password_hash TEXT, reset_code TEXT, verify_code TEXT)`);
  await dbRun(`INSERT INTO users VALUES (1, 'Alice', '76561198000000001', 'user', 'active', 150.25,
    '2026-09-01 10:00:00', '2026-09-02 11:00:00', 'alice@example.test', 1, '/avatar.webp', '', '', 'SECRET_HASH', 'SECRET_RESET', 'SECRET_VERIFY')`);
  await dbRun(`INSERT INTO users (id,username,role,status,balance,created_at) VALUES (2,'Bob','streamer','banned',0,'2026-08-01 10:00:00')`);
  await dbRun('CREATE TABLE transactions (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, amount REAL, comment TEXT, created_at TEXT)');
  await dbRun(`INSERT INTO transactions VALUES (1,1,'deposit',200,'fixture','2026-09-01 10:00:00'),
    (2,1,'case_open',-100,'fixture','2026-09-01 11:00:00'),(3,1,'case_win',50,'fixture','2026-09-01 11:00:00')`);
  await dbRun('CREATE TABLE kyc_requests (id INTEGER PRIMARY KEY, user_id TEXT, status TEXT, level INTEGER, created_at TEXT, reviewed_at TEXT)');
  await dbRun('CREATE TABLE kyc_levels (id INTEGER PRIMARY KEY, level INTEGER, title TEXT, enabled INTEGER)');
  await dbRun("INSERT INTO kyc_requests VALUES (1,'1','pending',1,'2026-09-01 10:00:00',NULL)");
  await dbRun("INSERT INTO kyc_levels VALUES (1,1,'Basic',1)");
  const app = express();
  app.use(express.json());
  const filename = path.resolve(__dirname, '../admin.titanrust.ru/server/server.js');
  const source = fs.readFileSync(filename, 'utf8');
  let start = source.indexOf("require('./userRoutes').register");
  if (start < 0) start = source.indexOf("app.get('/api/v1/admin/users',");
  const end = source.indexOf("require('./bannerRoutes').register", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), { app, DB_PATH, dbAll, dbGet, dbRun, require: createRequire(filename),
    requireAdminJWT: (req, res, next) => {
      req.user={userId:99,role:req.headers['x-admin-role'] || 'SUPER_ADMIN'};
      return req.headers['x-deny'] ? res.sendStatus(403) : next();
    } });
  app.all('/api/v1/admin/*', (req, res) => res.json({ success: true, data: [], catchAll: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  return { request, dbGet, dbRun };
}

// AC19: the deployed tabs consume data.items, not an unhandled catch-all array.
test('AC19: bets return actual ledger stakes',async t=>{
  const {request}=await fixture(t);
  const r=await request('/wallet/1/bets');
  assert.equal(r.status,200);
  assert.equal(r.body.catchAll,undefined);
  assert.equal(r.body.data.total,1);
  assert.equal(r.body.data.items[0].betAmount,'100.00');
  assert.equal(r.body.data.items[0].type,'CASE');
  // Legacy transactions have no round identifier: do not invent a win pairing.
  assert.equal(r.body.data.items[0].winAmount,null);
});
test('AC20: deposits show legacy credits with UTC date filtering',async t=>{
  const {request}=await fixture(t);
  const r=await request('/wallet/1/deposits?from=2026-09-01T10:00:00Z&to=2026-09-01T10:00:00Z');
  assert.equal(r.body.catchAll,undefined);
  assert.equal(r.body.data.total,1);
  assert.equal(r.body.data.items[0].amount,'200.00');
  assert.equal((await request('/wallet/1/deposits?from=2026-09-02T00:00:00Z')).body.data.total,0);
  assert.equal((await request('/wallet/1/bets?from=invalid')).status,400);
  assert.equal((await request('/wallet/999/bets')).status,404);
});

test('AC21: ladder reflects the site participation model',async t=>{
  const {request}=await fixture(t);
  const r=await request('/deposit-chain/users/1');
  assert.equal(r.body.catchAll,undefined);
  assert.equal(r.body.data.enrolled,true);
  assert.equal(r.body.data.totalDeposited,'200.00');
  assert.deepEqual(r.body.data.claims,[]);
  assert.equal(r.body.data.qaEnrollmentAvailable,false);
});
test('AC22: voiding a ladder claim does not reverse its prize',async t=>{
  const {request,dbRun,dbGet}=await fixture(t);
  await dbRun('CREATE TABLE deposit_chain_claims(user_id INTEGER,tier_index INTEGER,status TEXT,item_json TEXT,amount REAL,case_name TEXT,opened_at TEXT,admin_user_id TEXT,void_reason TEXT,PRIMARY KEY(user_id,tier_index))');
  await dbRun("INSERT INTO deposit_chain_claims(user_id,tier_index,status,amount) VALUES(1,0,'CONSUMED',25)");
  const r=await request('/deposit-chain/users/1/claims/0/void','POST',{reason:'Ошибка настройки'});
  assert.equal(r.status,200);
  assert.equal((await dbGet('SELECT status FROM deposit_chain_claims')).status,'VOIDED');
  assert.equal((await dbGet('SELECT balance FROM users WHERE id=1')).balance,150.25);
  assert.equal((await request('/deposit-chain/users/1/enroll','POST',{variant:'B'})).status,404);
});

// AC18: production used the pre-email schema. Regression checks exercise that
// migration through HTTP, not a newly-created ideal schema (Gate 2).
test('AC18: old user schema loads without changing balances or Steam identities', async t => {
  const { request, dbRun, dbGet } = await fixture(t);
  for (const column of ['email','email_verified','avatar','profile_url','trade_link','last_login_at']) {
    await dbRun(`ALTER TABLE users DROP COLUMN ${column}`);
  }
  const responses = await Promise.all([request('/users'), request('/users?search=Alice'), request('/users/1')]);
  for (const r of responses) assert.equal(r.status,200,JSON.stringify(r.body));
  const user=responses[0].body.data.find(u=>u.userId==='1');
  assert.equal(user.email,null);assert.equal(user.emailVerified,false);
  assert.equal(user.balance,'150.25');assert.equal(user.identities[0].externalId,'76561198000000001');
  assert.equal((await dbGet('SELECT password_hash FROM users WHERE id=1')).password_hash,'SECRET_HASH');
  assert.equal((await request('/users')).status,200);
});

test('AC1: list exposes usable user identifiers', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/users');
  assert.equal(body.data.find(u => u.username === 'Alice').userId, '1');
  assert.equal(body.pagination.total, 2);
});
test('AC2: credentials never appear in the user list', async t => {
  const { request } = await fixture(t);
  assert.doesNotMatch(JSON.stringify((await request('/users')).body), /SECRET|password_hash|reset_code|verify_code/);
});
test('AC3: filters apply before pagination', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/users?search=Alice&roles[]=USER&balanceMin=150&limit=1&page=1');
  assert.equal(body.data.length, 1);
  assert.equal(body.pagination.total, 1);
  assert.equal(body.data[0].createdAt, '2026-09-01T10:00:00.000Z');
});
test('AC4: profile returns a nested user', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/users/1');
  assert.equal(body.data.user?.userId, '1');
  assert.equal(body.data.user.role, 'USER');
  assert.equal(body.data.user.identities[0].provider, 'steam');
  assert.doesNotMatch(JSON.stringify(body), /SECRET/);
});
test('AC5: invalid user does not return fake success', async t => {
  const { request } = await fixture(t);
  for (const id of ['undefined', '999999', '0']) assert.equal((await request('/users/' + id)).status, 404);
});
test('AC6: wallet reads the shared balance', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/wallet/1');
  assert.equal(body.data.wallet?.balance, '150.25');
  assert.equal(body.data.wallet.recentTransactions.length, 3);
});
test('AC7: financial stats use ledger amounts', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/wallet/1/financial-stats');
  assert.equal(body.data.depositTotal, '200.00');
  assert.equal(body.data.betTotal, '100.00');
  assert.equal(body.data.winTotal, '50.00');
});
test('AC8: nickname change persists', async t => {
  const { request, dbGet } = await fixture(t);
  const response = await request('/users/1/display-name', 'PUT', { displayName: 'AliceNew' });
  assert.equal(response.status, 200);
  assert.equal((await dbGet('SELECT username FROM users WHERE id=1')).username, 'AliceNew');
  const history = (await request('/users/1/username-history')).body.data.entries;
  assert.equal(history[0].oldUsername, 'Alice');
  assert.equal(history[0].newUsername, 'AliceNew');
});
for (const length of [2, 3, 32, 33]) test(`AC9: nickname length ${length}`, async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/users/1/display-name', 'PUT', { displayName: 'x'.repeat(length) })).status, length < 3 || length > 32 ? 400 : 200);
});
test('AC10: profile route preserves the authorization gate', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/users/1', 'GET', undefined, { 'x-deny': '1' })).status, 403);
});

test('AC11: game stats contain actual ledger totals', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/users/1/game-stats');
  assert.ok(Array.isArray(body.data.stats));
  assert.equal(body.data.stats.find(s => s.game === 'case').wagered, '100.00');
});
test('AC12: balance history aggregates dates', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/wallet/1/balance-history?granularity=day');
  assert.equal(body.data.buckets?.length, 1);
  assert.equal(body.data.buckets[0].deposits, '200.00');
  assert.equal(body.data.buckets[0].betProfit, '-50.00');
});
test('AC13: incomplete manual credits fail before accessing the real database', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/wallet/1/manual-deposit', 'POST', { amount: '100' })).status, 400);
});
test('AC14: KYC pending filter matches stored lowercase status', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/kyc?status=PENDING');
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].userId, '1');
  assert.equal(body.data[0].levelName, 'Basic');
  assert.equal(body.pagination.total, 1);
});
test('AC15: KYC levels match the dropdown contract', async t => {
  const { request } = await fixture(t);
  const { body } = await request('/kyc/levels');
  assert.equal(body.data.levels?.[0].name, 'Basic');
  assert.equal(body.data.levels[0].isActive, true);
});
test('AC16: KYC edits persist the selected level and status', async t => {
  const { request, dbGet } = await fixture(t);
  const response = await request('/kyc/1', 'PUT', { status: 'APPROVED', levelName: 'Basic' });
  assert.equal(response.status, 200);
  assert.equal((await dbGet('SELECT status FROM kyc_requests WHERE id=1')).status, 'approved');
  assert.equal((await request('/users/1')).body.data.user.kycStatus, 'APPROVED');
});
test('AC17: KYC rejects an unknown level', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/kyc/1', 'PUT', { status:'APPROVED', levelName:'missing' })).status, 400);
});

test('AC23: SUPER_ADMIN changes a site user role and records the reason', async t => {
  const { request, dbGet } = await fixture(t);
  const response = await request('/users/1/role', 'PATCH', { role: 'STREAMER', reason: 'Подтверждённый стример' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.user.role, 'STREAMER');
  assert.equal((await dbGet('SELECT role FROM users WHERE id=1')).role, 'streamer');
  const audit = await dbGet('SELECT * FROM user_role_history WHERE user_id=1');
  assert.equal(audit.old_role, 'USER');
  assert.equal(audit.new_role, 'STREAMER');
  assert.equal(audit.reason, 'Подтверждённый стример');
  assert.equal(audit.admin_user_id, '99');
});

test('AC24: role change validates authority, role and reason without modifying the user', async t => {
  const { request, dbGet } = await fixture(t);
  assert.equal((await request('/users/1/role', 'PATCH', { role: 'STREAMER', reason: 'Нет прав' }, { 'x-admin-role': 'ADMIN' })).status, 403);
  assert.equal((await request('/users/1/role', 'PATCH', { role: 'SUPER_ADMIN', reason: 'Эскалация' })).status, 400);
  assert.equal((await request('/users/1/role', 'PATCH', { role: 'STREAMER', reason: '' })).status, 400);
  assert.equal((await dbGet('SELECT role FROM users WHERE id=1')).role, 'user');
});

// AC25: вкладка «Ставки» показывала выплату/множитель/прибыль как «—», потому что
// эти поля были захардкожены в null. Теперь каждая ставка связывается со своим
// выигрышем: апгрейдер и замес — по строке *_win, кейс — по предмету inventory.
test('AC25: bets pair payout, profit and multiplier per game', async t => {
  const { request, dbRun } = await fixture(t);
  await dbRun(`INSERT INTO users (id,username,role,status,balance,created_at) VALUES (3,'Carol','user','active',0,'2026-09-05 10:00:00')`);
  await dbRun(`CREATE TABLE inventory (id INTEGER PRIMARY KEY, user_id TEXT, item_id INTEGER, name TEXT, image TEXT,
    price REAL, source TEXT, source_ref TEXT, status TEXT, created_at TEXT)`);
  // Кейс: ставка 300, выпал предмет на 500 (в inventory, тот же момент).
  await dbRun(`INSERT INTO transactions VALUES (10,3,'case_open',-300,'Открытие: Кепка x1','2026-09-05 10:31:00')`);
  await dbRun(`INSERT INTO inventory (id,user_id,item_id,name,price,source,source_ref,status,created_at)
    VALUES (1,'3',7,'Скин',500,'case','Кепка','owned','2026-09-05 10:31:00')`);
  // Апгрейд выигрышный: ставка 1000, выплата 2500.
  await dbRun(`INSERT INTO transactions VALUES (11,3,'upgrade',-1000,'Апгрейд x2.50','2026-09-05 10:32:00')`);
  await dbRun(`INSERT INTO transactions VALUES (12,3,'upgrade_win',2500,'Скин','2026-09-05 10:32:00')`);
  // Апгрейд проигрышный: ставка 1000, выплаты нет — исход известен, это 0, а не «—».
  await dbRun(`INSERT INTO transactions VALUES (13,3,'upgrade',-1000,'Апгрейд x3.00','2026-09-05 10:33:00')`);
  // Замес: взнос 1198, победа 2396.
  await dbRun(`INSERT INTO transactions VALUES (14,3,'battle_entry',-1198,'Создание замеса','2026-09-05 10:34:00')`);
  await dbRun(`INSERT INTO transactions VALUES (15,3,'battle_win',2396,'Победа','2026-09-05 10:34:00')`);

  const r = await request('/wallet/3/bets');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.total, 4);
  const byId = Object.fromEntries(r.body.data.items.map(i => [i.id, i]));
  assert.deepEqual(
    { win: byId['10'].winAmount, mult: byId['10'].multiplier, edge: byId['10'].houseEdge },
    { win: '500.00', mult: 1.67, edge: '-200.00' });                       // кейс, прибыль игрока
  assert.deepEqual(
    { win: byId['11'].winAmount, mult: byId['11'].multiplier }, { win: '2500.00', mult: 2.5 }); // апгрейд-победа
  assert.deepEqual(
    { win: byId['13'].winAmount, mult: byId['13'].multiplier, edge: byId['13'].houseEdge },
    { win: '0.00', mult: 0, edge: '1000.00' });                            // апгрейд-проигрыш известен
  assert.equal(byId['14'].winAmount, '2396.00');                           // замес-победа
});

// AC26: у кейса без записи о выпавших предметах исход неизвестен — не выдумываем 0
// (из кейса всегда что-то выпадает), показываем «—».
test('AC26: a case with no inventory evidence stays unknown', async t => {
  const { request } = await fixture(t);
  const r = await request('/wallet/1/bets');           // fixture: case_open без inventory
  assert.equal(r.body.data.items[0].winAmount, null);
  assert.equal(r.body.data.items[0].multiplier, null);
  assert.equal(r.body.data.items[0].houseEdge, null);
});
