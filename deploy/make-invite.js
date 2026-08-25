#!/usr/bin/env node
'use strict';

/**
 * Ссылка-приглашение для регистрации passkey в админке.
 *
 * Зачем нужен отдельный скрипт: экран /register в бандле не показывает форму
 * без токена в адресе, а самое первое приглашение владельцу выдать некому —
 * администраторов ещё нет. Поэтому первый токен кладётся в базу напрямую,
 * а дальше владелец приглашает остальных из админки.
 *
 * Пишет прямо в базу и не требует, чтобы сервер был запущен.
 *
 *   node deploy/make-invite.js                       владелец, 24 часа
 *   node deploy/make-invite.js --role MODERATOR      другая роль
 *   node deploy/make-invite.js --username Klacho     привязать к логину
 *   node deploy/make-invite.js --hours 2             другой срок
 *   node deploy/make-invite.js --url https://admin.titanrust.ru
 *
 * Токен одноразовый: гаснет, как только по нему заведут ключ.
 */

const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env не обязателен */ }

const sqlite3 = require(path.join(ROOT, 'admin.titanrust.ru', 'server', 'node_modules', 'sqlite3'));
const DB_PATH = path.join(ROOT, 'admin.titanrust.ru', 'server', 'database.sqlite');

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'MODERATOR', 'VIEWER'];

// --- аргументы --------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

if (args.includes('-h') || args.includes('--help')) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, '').trim());
  process.exit(0);
}

const role = String(opt('role', 'SUPER_ADMIN')).toUpperCase();
if (!ROLES.includes(role)) {
  console.error(`Неизвестная роль «${role}». Допустимые: ${ROLES.join(', ')}`);
  process.exit(1);
}

const hours = Number(opt('hours', 24));
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('--hours должен быть положительным числом');
  process.exit(1);
}

const username = opt('username', null);

// Адрес админки: из аргумента, иначе первый https-origin из ADMIN_ORIGINS.
const baseUrl = String(opt('url',
  (process.env.ADMIN_ORIGINS || '').split(',').map(s => s.trim()).find(s => s.startsWith('http'))
  || 'https://admin.titanrust.ru'
)).replace(/\/+$/, '');

// --- дело -------------------------------------------------------------------

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((ok, no) => db.run(sql, p, function (e) { e ? no(e) : ok(this); }));
const get = (sql, p = []) => new Promise((ok, no) => db.get(sql, p, (e, r) => e ? no(e) : ok(r)));

(async () => {
  await run(`CREATE TABLE IF NOT EXISTS admin_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE,
      target_role TEXT DEFAULT 'VIEWER',
      username TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      used_at TIMESTAMP,
      admin_user_id INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE, email TEXT UNIQUE, password TEXT,
      role TEXT DEFAULT 'SUPER_ADMIN',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Владелец обычно уже засеян как SUPER_ADMIN при первом запуске админки.
  // Если приглашение для него и логин не указан — привязываем к этой строке,
  // чтобы не плодить вторую учётку владельца.
  let targetUser = null;
  if (username) {
    targetUser = await get(`SELECT * FROM admin_users WHERE username = ?`, [username]);
  } else if (role === 'SUPER_ADMIN') {
    targetUser = await get(`SELECT * FROM admin_users WHERE role = 'SUPER_ADMIN' ORDER BY id ASC LIMIT 1`);
  }

  // 32 байта: токен уходит в адресную строку и работает как пропуск.
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  const r = await run(
    `INSERT INTO admin_invites (token, target_role, username, created_by, expires_at, admin_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [token, role, username || (targetUser ? targetUser.username : null),
     'консоль сервера', expiresAt, targetUser ? targetUser.id : null]);

  const link = `${baseUrl}/register?token=${token}`;

  console.log('');
  console.log('  Приглашение создано.');
  console.log('');
  console.log(`  Роль:        ${role}`);
  console.log(`  Учётка:      ${targetUser ? targetUser.username : (username || 'будет создана при регистрации')}`);
  console.log(`  Действует:   ${hours} ч, до ${new Date(expiresAt).toLocaleString('ru-RU')}`);
  console.log(`  Одноразовое: гаснет сразу после того, как по нему заведут ключ`);
  console.log('');
  console.log('  Откройте эту ссылку в браузере, где будет храниться ключ:');
  console.log('');
  console.log(`  ${link}`);
  console.log('');

  if (String(process.env.ADMIN_RP_ID || '') && !baseUrl.includes(process.env.ADMIN_RP_ID)) {
    console.log(`  ! ADMIN_RP_ID=${process.env.ADMIN_RP_ID} не совпадает с доменом ссылки.`);
    console.log('    Ключ выпускается на RP ID, и на чужом домене он не сработает.');
    console.log('');
  }

  db.close();
  if (!r) process.exit(1);
})().catch((e) => {
  console.error('Не получилось:', e.message);
  process.exit(1);
});
