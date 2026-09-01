'use strict';

/**
 * Вход в админку по ключу доступа.
 *
 * Зачем в дополнение к passkey: собранный фронт админки умеет только WebAuthn,
 * а он требует настроенного аутентификатора — Windows Hello, Touch ID или
 * USB-брелок. Пока их нет, войти невозможно вообще никак, и админка остаётся
 * открытой всем без токена, что гораздо хуже.
 *
 * Ключ выдаёт владелец в панели, либо — самый первый — из консоли сервера.
 *
 * Что важно в устройстве:
 *
 *   В базе лежит SHA-256 от ключа, а не сам ключ. Утёкшая база не даёт войти.
 *   Открытым текстом ключ показывается ровно один раз, при создании.
 *
 *   Сравнение идёт по хэшу через индекс, но результат проверяется ещё раз
 *   timingSafeEqual — чтобы время ответа не зависело от того, насколько
 *   присланный ключ похож на настоящий.
 *
 *   Попытки входа ограничены по IP: ключ это предъявительский пропуск, и
 *   перебирать его должно быть бессмысленно.
 */

const crypto = require('crypto');

/** Префикс, чтобы ключ узнавался с первого взгляда и не путался с токеном. */
const PREFIX = 'trk_';

/** Ограничение перебора: сколько неудач с одного адреса и за какое время. */
const MAX_FAILS = Number(process.env.ADMIN_KEY_MAX_FAILS || 10);
const FAIL_WINDOW_MS = Number(process.env.ADMIN_KEY_FAIL_WINDOW_MS || 15 * 60 * 1000);

const fails = new Map();

function tooManyFails(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.at > FAIL_WINDOW_MS) { fails.delete(ip); return false; }
  return rec.n >= MAX_FAILS;
}

function noteFail(ip) {
  const rec = fails.get(ip);
  if (!rec || Date.now() - rec.at > FAIL_WINDOW_MS) fails.set(ip, { n: 1, at: Date.now() });
  else rec.n++;
  // Чистим старое, чтобы карта не росла бесконечно.
  for (const [k, v] of fails) if (Date.now() - v.at > FAIL_WINDOW_MS) fails.delete(k);
}

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

/** Новый ключ: сам ключ, его хэш и видимый префикс для списка. */
function generateKey() {
  const raw = PREFIX + crypto.randomBytes(24).toString('base64url');
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, 12) };
}

function register({ app, db, dbAll, dbGet, dbRun, generateAdminJWT, requireAdminJWT, access }) {

  db.run(`CREATE TABLE IF NOT EXISTS admin_access_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT UNIQUE,
      key_prefix TEXT,
      label TEXT,
      admin_user_id INTEGER,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP,
      expires_at TIMESTAMP,
      revoked_at TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_admin_keys_hash ON admin_access_keys(key_hash)`);

  // -------------------------------------------------------------------------
  // Вход
  // -------------------------------------------------------------------------

  app.post('/api/v1/admin/auth/key/login', async (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';

    if (tooManyFails(ip)) {
      console.warn(`[Ключ] Слишком много неудачных попыток с ${ip}`);
      return res.status(429).json({
        success: false, code: 'TOO_MANY_ATTEMPTS',
        message: 'Слишком много попыток. Подождите и попробуйте снова.'
      });
    }

    const key = String(req.body?.key || '').trim();
    if (!key) {
      noteFail(ip);
      return res.status(400).json({ success: false, message: 'Ключ не указан' });
    }

    const row = await dbGet(
      `SELECT * FROM admin_access_keys WHERE key_hash = ?`, [hashKey(key)]).catch(() => null);

    // Ответ одинаковый и для неизвестного, и для отозванного, и для истёкшего:
    // иначе по разнице сообщений можно узнать, что ключ когда-то существовал.
    const deny = () => {
      noteFail(ip);
      return res.status(401).json({ success: false, code: 'BAD_KEY', message: 'Ключ недействителен' });
    };

    if (!row) return deny();
    if (row.revoked_at) return deny();
    // Сравниваем время, а не строки: форматы дат в базе разные, строковое
    // сравнение здесь врёт — на этом в проекте уже обжигались.
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return deny();

    // Хэш уже совпал по индексу, но сверяем ещё раз постоянным по времени
    // сравнением — так ответ не быстрее для «почти угаданного» ключа.
    const a = Buffer.from(hashKey(key));
    const b = Buffer.from(String(row.key_hash));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return deny();

    const admin = (await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [row.admin_user_id]).catch(() => null))
      || (await dbGet(`SELECT * FROM admin_users ORDER BY id ASC LIMIT 1`).catch(() => null))
      || { id: 1, username: 'SUPER_ADMIN', role: 'SUPER_ADMIN' };

    await dbRun(`UPDATE admin_access_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id])
      .catch(() => {});
    fails.delete(ip);

    const token = generateAdminJWT(admin);
    console.log(`[Ключ] Вход: ${admin.username} (роль ${admin.role || 'SUPER_ADMIN'}), ключ ${row.key_prefix}…`);
    res.json({
      success: true,
      data: {
        accessToken: token,
        user: { userId: admin.id, username: admin.username, role: access.normalizeRole(admin.role) }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Управление ключами. Домен `admins` — то есть только владелец.
  // -------------------------------------------------------------------------

  // Литеральный путь объявляется до /admins/:id, иначе Express примет
  // "keys" за идентификатор.
  app.get('/api/v1/admin/admins/keys', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(
      `SELECT k.id, k.key_prefix, k.label, k.created_by, k.created_at, k.last_used_at,
              k.expires_at, k.revoked_at, u.username, u.role
         FROM admin_access_keys k
         LEFT JOIN admin_users u ON u.id = k.admin_user_id
        ORDER BY k.id DESC LIMIT 200`).catch(() => []);

    // Сам ключ не отдаём никогда: в базе его нет, только хэш.
    const data = rows.map(r => ({
      ...r,
      status: r.revoked_at ? 'отозван'
        : (r.expires_at && Date.parse(r.expires_at) < Date.now() ? 'истёк' : 'активен')
    }));
    res.json({ success: true, data, items: data, total: data.length });
  });

  app.post('/api/v1/admin/admins/keys', requireAdminJWT, async (req, res) => {
    try {
      const body = req.body || {};
      const username = String(body.username || '').trim();
      const role = String(body.role || 'VIEWER').toUpperCase();
      if (!access.ROLE_NAMES.includes(role)) {
        return res.status(400).json({
          success: false, message: `Неизвестная роль. Допустимые: ${access.ROLE_NAMES.join(', ')}` });
      }

      // Учётка: существующая по логину, иначе заводим новую с этой ролью.
      let admin = username
        ? await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [username]).catch(() => null)
        : await dbGet(`SELECT * FROM admin_users ORDER BY id ASC LIMIT 1`).catch(() => null);

      if (!admin && username) {
        const r = await dbRun(`INSERT INTO admin_users (username, role) VALUES (?, ?)`, [username, role]);
        admin = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [r.lastID]);
      }
      if (!admin) return res.status(400).json({ success: false, message: 'Не указан администратор' });

      const days = Math.min(Math.max(Number(body.days) || 365, 1), 3650);
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      const { raw, hash, prefix } = generateKey();

      await dbRun(
        `INSERT INTO admin_access_keys (key_hash, key_prefix, label, admin_user_id, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [hash, prefix, body.label || `Ключ ${admin.username}`, admin.id,
         req.user?.username || 'SUPER_ADMIN', expiresAt]);

      console.log(`[Ключ] ${req.user?.username} выписал ключ для ${admin.username} (${admin.role})`);
      res.json({
        success: true,
        data: {
          // Единственный раз, когда ключ виден. Дальше в базе только хэш.
          key: raw,
          prefix, expiresAt,
          username: admin.username,
          role: access.normalizeRole(admin.role),
          warning: 'Сохраните ключ сейчас — показать его снова невозможно'
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.delete('/api/v1/admin/admins/keys/:id', requireAdminJWT, async (req, res) => {
    const r = await dbRun(
      `UPDATE admin_access_keys SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revoked_at IS NULL`, [req.params.id]).catch(() => null);
    if (!r || !r.changes) {
      return res.status(404).json({ success: false, message: 'Ключ не найден или уже отозван' });
    }
    console.log(`[Ключ] ${req.user?.username} отозвал ключ №${req.params.id}`);
    res.json({ success: true, data: { revoked: req.params.id } });
  });

  return { generateKey, hashKey, PREFIX };
}

module.exports = { register, generateKey, hashKey, PREFIX };
