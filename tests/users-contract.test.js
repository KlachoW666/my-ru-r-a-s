'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  const db = new sqlite.Database(':memory:');
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
  vm.runInNewContext(source.slice(start, end), { app, dbAll, dbGet, dbRun, require: createRequire(filename),
    requireAdminJWT: (req, res, next) => req.headers['x-deny'] ? res.sendStatus(403) : next() });
  app.all('/api/v1/admin/*', (req, res) => res.json({ success: true, data: [], catchAll: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); });
  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  return { request, dbGet, dbRun };
}

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
test('AC13: unsupported operations fail explicitly', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/wallet/1/manual-deposit', 'POST', { amount: '100' })).status, 501);
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
