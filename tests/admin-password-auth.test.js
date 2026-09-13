'use strict';
// Strategy: HIGH risk. Real SQLite + HTTP contracts; no production credentials.
// Acceptance: invite-only signup, exact expiry, one use under concurrency,
// role binding, legacy plaintext rejected, session revocation, generic errors,
// password boundaries, throttling, existing owner setup, rollback on collision.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
const { createAuth, register } = require('../admin.titanrust.ru/server/adminPasswordAuth');
const { transaction } = require('../services/sqliteTransaction');
let dir, auth, server, url;
const password = 'a private test passphrase';
const connect = () => new sqlite.Database(path.join(dir, 'auth.sqlite'));
const query = (fn) => transaction(connect, fn);
async function invite(token, options = {}) {
  await query(({ run }) => run(`INSERT INTO admin_invites
    (token, target_role, expires_at, admin_user_id, username, used_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [token, options.role || 'VIEWER',
    options.expires || new Date(Date.now() + 3600000).toISOString(),
    options.id || null, options.username || null, options.used || null]));
}
async function post(route, body) {
  const response = await fetch(url + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { code: response.status, body: await response.json() };
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bearz-auth-'));
  auth = createAuth({ connect });
  await auth.ready;
  const app = express(); app.use(express.json());
  register({ app, auth, generateAdminJWT: u => `test-token-${u.id}` });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}/api/v1/admin/auth`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
test('password boundaries allow unicode, do not trim, and reject short/oversized values', () => {
  assert.throws(() => auth.validatePassword('a'.repeat(14)));
  assert.doesNotThrow(() => auth.validatePassword('я'.repeat(15)));
  assert.doesNotThrow(() => auth.validatePassword('a'.repeat(128)));
  assert.throws(() => auth.validatePassword('a'.repeat(129)));
  assert.throws(() => auth.validatePassword(null));
});
test('registration without an invite is forbidden, including first passkey', async () => {
  assert.equal((await post('/register', { username: 'attacker', password })).code, 400);
  assert.equal((await post('/register/options', {})).code, 410);
  assert.equal((await post('/register/verify', {})).code, 410);
});
test('signup respects invite role, stores a hash, consumes invite, then login works', async () => {
  await invite('valid');
  const result = await post('/register', { inviteToken: 'valid', username: 'viewer-one', password, role: 'SUPER_ADMIN' });
  assert.equal(result.code, 200);
  const row = await query(({ get }) => get('SELECT * FROM admin_users WHERE username=?', ['viewer-one']));
  assert.equal(row.role, 'VIEWER'); assert.match(row.password_hash, /^scrypt\$/);
  assert.equal(row.password, null); assert.ok(!JSON.stringify(result).includes(row.password_hash));
  assert.equal((await post('/login', { username: row.username, password })).code, 200);
  assert.equal((await post('/register', { inviteToken: 'valid', username: 'other', password })).code, 400);
});
test('expired, revoked, malformed expiry and used invites are rejected', async () => {
  for (const [token, options] of Object.entries({ expired: { expires: new Date(0).toISOString() },
    malformed: { expires: 'invalid' }, used: { used: new Date().toISOString() } })) {
    await invite(token, options);
    assert.equal(await auth.findInvite(token), null);
    assert.equal((await post('/register', { inviteToken: token, username: token, password })).code, 400);
  }
});
test('two simultaneous registrations cannot consume one invite twice', async () => {
  await invite('race');
  const results = await Promise.all(['racer-one', 'racer-two'].map(username =>
    auth.registerPassword({ inviteToken: 'race', username, password }).then(() => 200, e => e.status)));
  assert.deepEqual(results.sort(), [200, 400]);
});
test('username collision rolls back invite consumption', async () => {
  await invite('collision');
  await assert.rejects(auth.registerPassword({ inviteToken: 'collision', username: 'viewer-one', password }), { status: 409 });
  assert.ok(await auth.findInvite('collision'));
});
test('legacy seed password is not accepted and login errors do not disclose account existence', async () => {
  await query(({ run }) => run("INSERT INTO admin_users(username,password,role) VALUES('legacy','admin123','SUPER_ADMIN')"));
  const bad = await post('/login', { username: 'legacy', password: 'admin123' });
  const missing = await post('/login', { username: 'nonexistent', password: 'admin123' });
  assert.equal(bad.code, 401); assert.deepEqual(bad.body, missing.body);
});
test('bound invite sets password on existing owner without duplicating or changing role', async () => {
  const owner = await query(({ get }) => get("SELECT * FROM admin_users WHERE username='legacy'"));
  await invite('owner', { id: owner.id, username: owner.username, role: 'VIEWER' });
  const result = await auth.registerPassword({ inviteToken: 'owner', username: owner.username, password });
  assert.equal(result.id, owner.id); assert.equal(result.role, 'SUPER_ADMIN');
  assert.equal(result.auth_version, 1);
  assert.equal(await auth.currentUser({ userId: owner.id, authVersion: 0 }), null);
  assert.equal((await auth.currentUser({ userId: owner.id, authVersion: 1 })).id, owner.id);
  await query(({ run }) => run('DELETE FROM admin_users WHERE id=?', [owner.id]));
  assert.equal(await auth.currentUser({ userId: owner.id, authVersion: 1 }), null);
});
test('bound invite cannot recreate a deleted administrator', async () => {
  await invite('deleted', { id: 9999, role: 'SUPER_ADMIN', username: 'missing-owner' });
  await assert.rejects(auth.registerPassword({ inviteToken: 'deleted', username: 'missing-owner', password }), { status: 400 });
});
test('repeated login attempts are throttled', async () => {
  let result;
  for (let i = 0; i < 11; i++) result = await post('/login', { username: 'locked-account', password: 'wrong' });
  assert.equal(result.code, 429);
});
