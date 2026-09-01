#!/usr/bin/env node
'use strict';

/**
 * Ключ доступа в админку.
 *
 * Самый первый ключ выдать некому — администраторов ещё нет, — поэтому он
 * создаётся прямо в базе. Дальше владелец выписывает остальные в панели.
 *
 *   node deploy/make-key.js                          владелец, на год
 *   node deploy/make-key.js --role MODERATOR --username Ivan
 *   node deploy/make-key.js --days 30
 *   node deploy/make-key.js --revoke 3               отозвать ключ
 *   node deploy/make-key.js --list                   показать выданные
 *
 * Сервер поднимать не нужно. В базе лежит только SHA-256 от ключа, поэтому
 * показать его повторно невозможно — сохраните сразу.
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const SERVER = path.join(ROOT, 'admin.titanrust.ru', 'server');
const sqlite3 = require(path.join(SERVER, 'node_modules', 'sqlite3'));
const keys = require(path.join(SERVER, 'adminKeys'));
const access = require(path.join(SERVER, 'adminAccess'));

const DB_PATH = path.join(SERVER, 'database.sqlite');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

if (args.includes('-h') || args.includes('--help')) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, '').trim());
  process.exit(0);
}

const db = new sqlite3.Database(DB_PATH);
db.configure('busyTimeout', 5000);
const run = (s, p = []) => new Promise((ok, no) => db.run(s, p, function (e) { e ? no(e) : ok(this); }));
const get = (s, p = []) => new Promise((ok, no) => db.get(s, p, (e, r) => e ? no(e) : ok(r)));
const all = (s, p = []) => new Promise((ok, no) => db.all(s, p, (e, r) => e ? no(e) : ok(r || [])));

(async () => {
  await run(`CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE, email TEXT UNIQUE, password TEXT,
      role TEXT DEFAULT 'SUPER_ADMIN',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS admin_access_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT UNIQUE, key_prefix TEXT, label TEXT,
      admin_user_id INTEGER, created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP, expires_at TIMESTAMP, revoked_at TIMESTAMP)`);

  // --- показать список ---
  if (args.includes('--list')) {
    const rows = await all(
      `SELECT k.id, k.key_prefix, k.label, k.created_at, k.last_used_at, k.expires_at,
              k.revoked_at, u.username, u.role
         FROM admin_access_keys k LEFT JOIN admin_users u ON u.id = k.admin_user_id
        ORDER BY k.id DESC`);
    if (!rows.length) console.log('\n  Ключей пока нет.\n');
    else {
      console.log('');
      for (const r of rows) {
        const st = r.revoked_at ? 'отозван'
          : (r.expires_at && Date.parse(r.expires_at) < Date.now() ? 'истёк' : 'активен');
        console.log(`  №${String(r.id).padEnd(3)} ${String(r.key_prefix + '…').padEnd(16)} ` +
                    `${String(r.username || '?').padEnd(14)} ${String(r.role || '').padEnd(12)} ${st}` +
                    (r.last_used_at ? `   последний вход ${r.last_used_at}` : '   ни разу не использован'));
      }
      console.log('');
    }
    db.close(); return;
  }

  // --- отозвать ---
  const revokeId = opt('revoke', null);
  if (revokeId) {
    const r = await run(
      `UPDATE admin_access_keys SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revoked_at IS NULL`, [revokeId]);
    console.log(r.changes ? `\n  Ключ №${revokeId} отозван.\n` : `\n  Ключ №${revokeId} не найден или уже отозван.\n`);
    db.close(); return;
  }

  // --- создать ---
  const role = String(opt('role', 'SUPER_ADMIN')).toUpperCase();
  if (!access.ROLE_NAMES.includes(role)) {
    console.error(`\n  Неизвестная роль «${role}». Допустимые: ${access.ROLE_NAMES.join(', ')}\n`);
    db.close(); process.exit(1);
  }
  const days = Math.min(Math.max(Number(opt('days', 365)), 1), 3650);
  const username = opt('username', null);

  // Владельцу без указанного логина отдаём засеянную строку SUPER_ADMIN,
  // чтобы не плодить вторую учётную запись владельца.
  let admin = username
    ? await get(`SELECT * FROM admin_users WHERE username = ?`, [username])
    : await get(`SELECT * FROM admin_users WHERE role = 'SUPER_ADMIN' ORDER BY id ASC LIMIT 1`);

  if (!admin) {
    const name = username || 'SUPER_ADMIN';
    const r = await run(`INSERT INTO admin_users (username, role) VALUES (?, ?)`, [name, role]);
    admin = await get(`SELECT * FROM admin_users WHERE id = ?`, [r.lastID]);
    console.log(`\n  Заведена учётная запись «${name}» с ролью ${role}.`);
  }

  const { raw, hash, prefix } = keys.generateKey();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

  await run(
    `INSERT INTO admin_access_keys (key_hash, key_prefix, label, admin_user_id, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [hash, prefix, opt('label', `Ключ ${admin.username}`), admin.id, 'консоль сервера', expiresAt]);

  const origin = String(process.env.ADMIN_ORIGINS || '')
    .split(',').map(s => s.trim()).find(s => s.startsWith('http')) || 'https://admin.titanrust.ru';

  console.log('');
  console.log('  Ключ доступа создан.');
  console.log('');
  console.log(`  Учётная запись: ${admin.username}`);
  console.log(`  Роль:           ${access.normalizeRole(admin.role)}`);
  console.log(`  Действует:      ${days} дн., до ${new Date(expiresAt).toLocaleDateString('ru-RU')}`);
  console.log('');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  ${raw}`);
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('');
  console.log('  Сохраните его сейчас: в базе лежит только хэш, показать');
  console.log('  повторно невозможно. Потеряли — выпишите новый.');
  console.log('');
  console.log(`  Вход: ${origin.replace(/\/+$/, '')}/key-login.html`);
  console.log('');

  db.close();
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
