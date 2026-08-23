'use strict';

/**
 * Регистрация и вход по e-mail.
 *
 * Раньше эти пути отдавали 501: фронт рисует экраны регистрации, восстановления
 * пароля и подтверждения почты, а серверной части не было.
 *
 * Почтового сервера в проекте нет, поэтому код подтверждения ПЕЧАТАЕТСЯ В ЛОГ.
 * Это осознанный компромисс, а не недосмотр: он позволяет пройти весь сценарий
 * целиком, и заменяется одной функцией sendMail, когда появится SMTP.
 * При MAIL_AUTO_VERIFY=1 почта считается подтверждённой сразу — удобно локально.
 *
 * Пароли хранятся как scrypt(пароль, соль) — из стандартной библиотеки crypto,
 * внешних зависимостей не требуется.
 */

const crypto = require('crypto');
const { sendVerificationCode, sendPasswordResetCode } = require('./mailer');

const AUTO_VERIFY = process.env.MAIL_AUTO_VERIFY === '1';
const CODE_TTL_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 8;

// ---------------------------------------------------------------------------
// Пароли
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e);
const newCode = () => String(crypto.randomInt(100000, 1000000));

// ---------------------------------------------------------------------------
// Схема
// ---------------------------------------------------------------------------

function makeStore({ openDb, run, get }) {
  let ready = false;

  async function ensureSchema() {
    if (ready) return;
    const db = openDb();
    if (!db) return;
    for (const col of [
      'email TEXT',
      'password_hash TEXT',
      'email_verified INTEGER DEFAULT 0',
      'verify_code TEXT',
      'verify_expires INTEGER',
      'reset_code TEXT',
      'reset_expires INTEGER'
    ]) {
      await run(db, `ALTER TABLE users ADD COLUMN ${col}`);   // идемпотентно
    }
    // Частичный индекс: NULL-почты не конфликтуют между собой.
    await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
                   ON users(email) WHERE email IS NOT NULL`);
    db.close();
    ready = true;
  }

  async function byEmail(email) {
    await ensureSchema();
    const db = openDb();
    if (!db) return null;
    const row = await get(db, `SELECT * FROM users WHERE email = ?`, [normalizeEmail(email)]);
    db.close();
    return row;
  }

  return { ensureSchema, byEmail, openDb, run, get };
}

// ---------------------------------------------------------------------------
// Роуты
// ---------------------------------------------------------------------------

/**
 * @param deps.issueSession(res, user) -> { accessToken } — ставит refresh-cookie
 *        и возвращает access-токен. Реализуется в auth.js, чтобы форма сессии
 *        была ровно та же, что у входа через Steam.
 */
function registerEmailRoutes(app, deps) {
  const { openDb, run, get, issueSession, toPublicUser } = deps;
  const store = makeStore({ openDb, run, get });

  const fail = (res, code, message, status = 400) =>
    res.status(status).json({ status: 'error', code, message });

  // --- Есть ли такая почта --------------------------------------------------
  app.get('/api/v1/auth/email/exists', async (req, res) => {
    const email = normalizeEmail(req.query.email);
    if (!isEmail(email)) return res.json({ status: 'success', data: { exists: false } });
    const row = await store.byEmail(email);
    res.json({ status: 'success', data: { exists: !!row } });
  });

  // --- Регистрация ----------------------------------------------------------
  app.post('/api/v1/auth/register/email', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      const username = String(req.body?.username || '').trim() || email.split('@')[0];

      if (!isEmail(email)) return fail(res, 'INVALID_EMAIL', 'Некорректный адрес почты');
      if (password.length < MIN_PASSWORD) {
        return fail(res, 'WEAK_PASSWORD', `Пароль должен быть не короче ${MIN_PASSWORD} символов`);
      }
      if (await store.byEmail(email)) {
        return fail(res, 'EMAIL_TAKEN', 'Такая почта уже зарегистрирована', 409);
      }

      await store.ensureSchema();
      const db = openDb();
      if (!db) return fail(res, 'DB_UNAVAILABLE', 'База недоступна', 503);

      const code = newCode();
      await run(db,
        `INSERT INTO users (username, email, password_hash, balance, rtp, role, status,
                            email_verified, verify_code, verify_expires, currency)
         VALUES (?, ?, ?, 0.0, 95.0, 'user', 'active', ?, ?, ?, 'RUB')`,
        [username, email, hashPassword(password), AUTO_VERIFY ? 1 : 0,
         AUTO_VERIFY ? null : code, AUTO_VERIFY ? null : Date.now() + CODE_TTL_MS]);
      const user = await get(db, `SELECT * FROM users WHERE email = ?`, [email]);
      db.close();

      if (AUTO_VERIFY) {
        const { accessToken } = issueSession(res, user);
        return res.json({ status: 'success', data: { accessToken, user: toPublicUser(user) } });
      }

      // Уходит письмом, если настроен SMTP; иначе печатается в лог (services/mailer.js).
      await sendVerificationCode(email, code);
      res.json({
        status: 'success',
        data: { email, verificationRequired: true },
        message: 'Код подтверждения отправлен'
      });
    } catch (e) {
      console.error('[EmailAuth] register:', e.message);
      fail(res, 'INTERNAL', e.message, 500);
    }
  });

  // --- Подтверждение почты --------------------------------------------------
  app.post('/api/v1/auth/verify/email', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    const row = await store.byEmail(email);
    if (!row) return fail(res, 'NOT_FOUND', 'Пользователь не найден', 404);
    if (row.email_verified === 1) {
      const { accessToken } = issueSession(res, row);
      return res.json({ status: 'success', data: { accessToken, user: toPublicUser(row) } });
    }
    if (!row.verify_code || row.verify_code !== code) {
      return fail(res, 'INVALID_CODE', 'Неверный код подтверждения');
    }
    if (row.verify_expires && Date.now() > Number(row.verify_expires)) {
      return fail(res, 'CODE_EXPIRED', 'Код истёк, запросите новый');
    }

    const db = openDb();
    await run(db, `UPDATE users SET email_verified = 1, verify_code = NULL, verify_expires = NULL WHERE id = ?`, [row.id]);
    const fresh = await get(db, `SELECT * FROM users WHERE id = ?`, [row.id]);
    db.close();

    const { accessToken } = issueSession(res, fresh);
    res.json({ status: 'success', data: { accessToken, user: toPublicUser(fresh) } });
  });

  app.post('/api/v1/auth/resend-verification', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const row = await store.byEmail(email);
    // Не подтверждаем существование адреса — иначе почту можно перебирать.
    if (!row || row.email_verified === 1) {
      return res.json({ status: 'success', message: 'Если адрес зарегистрирован, код отправлен' });
    }
    const code = newCode();
    const db = openDb();
    await run(db, `UPDATE users SET verify_code = ?, verify_expires = ? WHERE id = ?`,
      [code, Date.now() + CODE_TTL_MS, row.id]);
    db.close();
    await sendVerificationCode(email, code);
    res.json({ status: 'success', message: 'Если адрес зарегистрирован, код отправлен' });
  });

  // --- Вход -----------------------------------------------------------------
  app.post('/api/v1/auth/login/email', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const row = await store.byEmail(email);

    // Одинаковый ответ на «нет пользователя» и «неверный пароль».
    if (!row || !verifyPassword(password, row.password_hash)) {
      return fail(res, 'INVALID_CREDENTIALS', 'Неверная почта или пароль', 401);
    }
    if (row.email_verified !== 1) {
      return fail(res, 'EMAIL_NOT_VERIFIED', 'Почта не подтверждена', 403);
    }
    if (row.status === 'banned') {
      return fail(res, 'BANNED', 'Учётная запись заблокирована', 403);
    }

    const { accessToken } = issueSession(res, row);
    res.json({ status: 'success', data: { accessToken, user: toPublicUser(row) } });
  });

  // --- Сброс пароля ---------------------------------------------------------
  app.post('/api/v1/auth/password-reset/request', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const row = await store.byEmail(email);
    if (row) {
      const code = newCode();
      const db = openDb();
      await run(db, `UPDATE users SET reset_code = ?, reset_expires = ? WHERE id = ?`,
        [code, Date.now() + CODE_TTL_MS, row.id]);
      db.close();
      await sendPasswordResetCode(email, code);
    }
    res.json({ status: 'success', message: 'Если адрес зарегистрирован, код отправлен' });
  });

  app.post('/api/v1/auth/password-reset/confirm', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    const password = String(req.body?.password || req.body?.newPassword || '');
    if (password.length < MIN_PASSWORD) {
      return fail(res, 'WEAK_PASSWORD', `Пароль должен быть не короче ${MIN_PASSWORD} символов`);
    }
    const row = await store.byEmail(email);
    if (!row || !row.reset_code || row.reset_code !== code) {
      return fail(res, 'INVALID_CODE', 'Неверный код');
    }
    if (row.reset_expires && Date.now() > Number(row.reset_expires)) {
      return fail(res, 'CODE_EXPIRED', 'Код истёк, запросите новый');
    }
    const db = openDb();
    await run(db, `UPDATE users SET password_hash = ?, reset_code = NULL, reset_expires = NULL,
                   email_verified = 1 WHERE id = ?`, [hashPassword(password), row.id]);
    const fresh = await get(db, `SELECT * FROM users WHERE id = ?`, [row.id]);
    db.close();
    const { accessToken } = issueSession(res, fresh);
    res.json({ status: 'success', data: { accessToken, user: toPublicUser(fresh) } });
  });

  // Смена пароля из профиля.
  app.put('/api/v1/user/password', async (req, res) => {
    if (!req.auth || req.auth.mock) return fail(res, 'UNAUTHORIZED', 'Требуется авторизация', 401);
    const current = String(req.body?.currentPassword || req.body?.oldPassword || '');
    const next = String(req.body?.password || req.body?.newPassword || '');
    if (next.length < MIN_PASSWORD) {
      return fail(res, 'WEAK_PASSWORD', `Пароль должен быть не короче ${MIN_PASSWORD} символов`);
    }
    await store.ensureSchema();
    const db = openDb();
    const row = await get(db, `SELECT * FROM users WHERE id = ?`, [req.auth.sub]);
    if (!row) { db.close(); return fail(res, 'NOT_FOUND', 'Пользователь не найден', 404); }
    if (row.password_hash && !verifyPassword(current, row.password_hash)) {
      db.close();
      return fail(res, 'INVALID_CREDENTIALS', 'Текущий пароль неверен', 403);
    }
    await run(db, `UPDATE users SET password_hash = ? WHERE id = ?`, [hashPassword(next), row.id]);
    db.close();
    res.json({ status: 'success', message: 'Пароль изменён' });
  });
}

module.exports = { registerEmailRoutes, hashPassword, verifyPassword, isEmail, normalizeEmail };
