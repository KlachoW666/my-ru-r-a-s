'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { transaction } = require('../../services/sqliteTransaction');
const access = require('./adminAccess');
const scrypt = promisify(crypto.scrypt);
const fail = (status, message) => Object.assign(new Error(message), { status });
const invalidInvite = () => fail(400, 'Приглашение недействительно или истекло. Запросите новое.');
const dummyHash = `scrypt$${Buffer.alloc(16).toString('hex')}$${Buffer.alloc(64).toString('hex')}`;

function createAuth({ connect }) {
  const tx = work => transaction(connect, work);
  const ready = tx(async ({ run, all }) => {
    await run(`CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE,
      password TEXT, role TEXT DEFAULT 'VIEWER', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    const columns = new Set((await all('PRAGMA table_info(admin_users)')).map(c => c.name));
    if (!columns.has('password_hash')) await run('ALTER TABLE admin_users ADD COLUMN password_hash TEXT');
    if (!columns.has('auth_version')) await run('ALTER TABLE admin_users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
    await run(`CREATE TABLE IF NOT EXISTS admin_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, target_role TEXT DEFAULT 'VIEWER',
      username TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP, used_at TIMESTAMP, admin_user_id INTEGER)`);
  });
  // Two expensive password operations at a time, bounded memory even under load.
  let hashing = 0;
  async function derive(password, salt) {
    if (hashing >= 2) throw fail(429, 'Слишком много попыток. Повторите позже.');
    hashing++;
    try { return await scrypt(password, salt, 64, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }); }
    finally { hashing--; }
  }
  function validatePassword(password) {
    if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 128) {
      throw fail(400, 'Пароль должен содержать от 15 до 128 символов. Можно использовать фразу.');
    }
  }
  async function validInvite(get, token) {
    if (typeof token !== 'string' || !token || token.length > 256) return null;
    const row = await get('SELECT * FROM admin_invites WHERE token = ?', [token]);
    if (!row || row.used_at || !row.expires_at) return null;
    const raw = String(row.expires_at);
    const expires = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw);
    if (!Number.isFinite(expires) || expires <= Date.now()) return null;
    if (!Object.hasOwn(access.ROLES, row.target_role)) return null;
    if (row.admin_user_id && !await get('SELECT id FROM admin_users WHERE id=?', [row.admin_user_id])) return null;
    return row;
  }
  async function findInvite(token) {
    await ready;
    return tx(({ get }) => validInvite(get, token));
  }
  async function registerPassword({ inviteToken, username, password }) {
    await ready;
    if (!await findInvite(inviteToken)) throw invalidInvite();
    validatePassword(password);
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
      throw fail(400, 'Логин: 3–64 символа, латинские буквы, цифры, точка, дефис или подчёркивание.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
    return tx(async ({ get, run }) => {
      const invite = await validInvite(get, inviteToken);
      if (!invite) throw invalidInvite();
      let admin = invite.admin_user_id ? await get('SELECT * FROM admin_users WHERE id=?', [invite.admin_user_id]) : null;
      if ((admin && username !== admin.username) || (invite.username && username !== invite.username)) {
        throw fail(400, 'Используйте логин, указанный в приглашении.');
      }
      if (!admin) {
        if (await get('SELECT id FROM admin_users WHERE username=? COLLATE NOCASE', [username])) {
          throw fail(409, 'Этот логин занят. Выберите другой или запросите приглашение для существующей учётной записи.');
        }
        const result = await run('INSERT INTO admin_users(username,role,password_hash) VALUES(?,?,?)', [username, invite.target_role, hash]);
        admin = { id: result.lastID };
      } else {
        await run('UPDATE admin_users SET password_hash=?, password=NULL, auth_version=auth_version+1 WHERE id=?', [hash, admin.id]);
      }
      const consumed = await run('UPDATE admin_invites SET used_at=CURRENT_TIMESTAMP,admin_user_id=? WHERE id=? AND used_at IS NULL', [admin.id, invite.id]);
      if (consumed.changes !== 1) throw invalidInvite();
      // Old recovery links for this account cannot undo a completed password change.
      await run('UPDATE admin_invites SET expires_at=? WHERE admin_user_id=? AND used_at IS NULL', [new Date(0).toISOString(), admin.id]);
      return get('SELECT * FROM admin_users WHERE id=?', [admin.id]);
    });
  }
  async function login(username, password) {
    await ready;
    const invalid = fail(401, 'Неверный логин или пароль.');
    if (typeof username !== 'string' || username.length > 64 || typeof password !== 'string' || password.length > 256) throw invalid;
    const admin = await tx(({ get }) => get('SELECT * FROM admin_users WHERE username=?', [username.trim()]));
    const stored = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(admin?.password_hash || '') ? admin.password_hash : dummyHash;
    const [, salt, expected] = stored.split('$');
    const derived = await derive(password, salt);
    if (!crypto.timingSafeEqual(derived, Buffer.from(expected, 'hex')) || stored === dummyHash) throw invalid;
    // Re-read after hashing so a concurrent reset or removal invalidates this login.
    const fresh = await tx(({ get }) => get('SELECT * FROM admin_users WHERE id=?', [admin.id]));
    if (!fresh || fresh.password_hash !== stored) throw invalid;
    return fresh;
  }
  async function currentUser(payload) {
    await ready;
    const user = await tx(({ get }) => get('SELECT * FROM admin_users WHERE id=?', [payload.userId]));
    return user && Number(user.auth_version) === Number(payload.authVersion || 0) ? user : null;
  }
  return { ready, validatePassword, findInvite, registerPassword, login, currentUser };
}

function register({ app, auth, generateAdminJWT }) {
  // Single fork process in PM2. Expiring, capped buckets; account + client limits.
  const buckets = new Map();
  function consume(key, max) {
    const now = Date.now();
    for (const [k, entry] of buckets) if (entry.until <= now) buckets.delete(k);
    let entry = buckets.get(key);
    if (!entry) {
      if (buckets.size >= 5000) throw fail(429, 'Слишком много попыток. Повторите через 15 минут.');
      entry = { count: 0, until: now + 15 * 60000 }; buckets.set(key, entry);
    }
    if (++entry.count > max) throw fail(429, 'Слишком много попыток. Повторите через 15 минут.');
  }
  const handle = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await auth.ready; await fn(req, res); }
    catch (error) {
      const status = error.status || 500;
      if (status === 429) res.set('Retry-After', '900');
      if (status === 500) console.error('[Admin auth]', error.message);
      res.status(status).json({ success: false, message: status === 500 ? 'Не удалось выполнить запрос. Повторите позже.' : error.message });
    }
  };
  function throttle(req, account = false) {
    consume(`ip:${req.ip || req.socket.remoteAddress}`, 40);
    if (account) consume(`user:${String(req.body?.username || '').trim().toLowerCase().slice(0, 64)}`, 10);
  }
  app.post('/api/v1/admin/auth/login', handle(async (req, res) => {
    throttle(req, true);
    const user = await auth.login(req.body?.username, req.body?.password);
    res.json({ success: true, data: { accessToken: generateAdminJWT(user), role: user.role } });
  }));
  app.post('/api/v1/admin/auth/register', handle(async (req, res) => {
    throttle(req);
    const user = await auth.registerPassword(req.body || {});
    res.json({ success: true, data: { registered: true, username: user.username } });
  }));
  app.get('/api/v1/admin/auth/invite/validate', handle(async (req, res) => {
    const invite = await auth.findInvite(req.query.token);
    res.json({ success: true, data: invite ? { valid: true, targetRole: invite.target_role,
      username: invite.username || '', createdBy: invite.created_by || '', expiresAt: invite.expires_at,
      existingAccount: Boolean(invite.admin_user_id) } : { valid: false } });
  }));
  // New accounts use password registration. Existing passkeys remain usable for login.
  for (const route of ['options', 'verify']) app.post(`/api/v1/admin/auth/register/${route}`, (_req, res) => {
    res.status(410).json({ success: false, message: 'Регистрация теперь по логину и паролю. Обновите страницу приглашения.' });
  });
}

module.exports = { createAuth, register };
