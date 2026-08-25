'use strict';

/**
 * Вход в админку по passkey (WebAuthn).
 *
 * Зачем: фронт админки умеет только passkey — usePasskeyAuth-CyfWqoD7.js делает
 *   POST /api/v1/admin/auth/login/options   -> { data: { optionsJson, challengeId } }
 *   startAuthentication(JSON.parse(optionsJson))
 *   POST /api/v1/admin/auth/login/verify    -> { data: { accessToken } }
 * Серверной части не было: /auth/login/options отдавал сразу готовый JWT без
 * optionsJson, поэтому реальный вход не работал, а requireAdminJWT пропускал
 * вообще всех. Включить ADMIN_REQUIRE_AUTH=1 было нельзя — доступ терялся.
 *
 * Теперь регистрация и вход настоящие, и защиту можно включать.
 *
 * Первый ключ регистрируется без приглашения, пока в базе нет ни одного —
 * иначе админку было бы невозможно настроить с нуля. Дальше нужен код из
 * ADMIN_INVITE_CODE.
 */

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const crypto = require('crypto');

/** Домен, для которого выпускаются ключи. Должен совпадать с адресом в браузере. */
const RP_ID = process.env.ADMIN_RP_ID || (process.env.NODE_ENV === 'production' ? 'titanrust.ru' : 'localhost');
const RP_NAME = 'TitanRust Admin';
const ORIGINS = String(process.env.ADMIN_ORIGINS ||
  (process.env.NODE_ENV === 'production'
    ? 'https://admin.titanrust.ru,https://titanrust.ru'
    : 'http://localhost:8080,http://127.0.0.1:8080')
).split(',').map(s => s.trim()).filter(Boolean);

const INVITE_CODE = process.env.ADMIN_INVITE_CODE || '';

/** Челленджи живут в памяти: они одноразовые и короткоживущие. */
const challenges = new Map();
const CHALLENGE_TTL = 5 * 60 * 1000;

function putChallenge(challenge, meta = {}) {
  const id = crypto.randomUUID();
  challenges.set(id, { challenge, ...meta, at: Date.now() });
  for (const [k, v] of challenges) if (Date.now() - v.at > CHALLENGE_TTL) challenges.delete(k);
  return id;
}
function takeChallenge(id) {
  const v = challenges.get(id);
  challenges.delete(id);
  if (!v || Date.now() - v.at > CHALLENGE_TTL) return null;
  return v;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function register({ app, db, dbAll, dbGet, dbRun, generateAdminJWT }) {
  // Таблица ключей. Создаётся идемпотентно, как остальные в initDatabase.
  db.run(`CREATE TABLE IF NOT EXISTS admin_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      credential_id TEXT UNIQUE,
      public_key TEXT,
      counter INTEGER DEFAULT 0,
      transports TEXT,
      label TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP
  )`);

  async function credentialCount() {
    const row = await dbGet(`SELECT COUNT(*) AS c FROM admin_credentials`).catch(() => null);
    return row ? row.c : 0;
  }

  async function defaultAdmin() {
    return (await dbGet(`SELECT * FROM admin_users ORDER BY id ASC LIMIT 1`).catch(() => null))
      || { id: 1, username: 'SUPER_ADMIN', email: 'admin@titanrust.ru', role: 'SUPER_ADMIN' };
  }

  // --- Регистрация ключа ----------------------------------------------------

  app.post('/api/v1/admin/auth/register/options', async (req, res) => {
    try {
      const count = await credentialCount();
      // Первый ключ — без приглашения, иначе админку не поднять с нуля.
      if (count > 0) {
        const code = req.body?.inviteCode || req.body?.invite || '';
        if (!INVITE_CODE || code !== INVITE_CODE) {
          return res.status(403).json({ success: false, message: 'Нужен действующий код приглашения (ADMIN_INVITE_CODE)' });
        }
      }

      // Ключ привязывается к конкретной строке admin_users — от неё берётся
      // роль при входе. Без username ключ уходит владельцу: так заводится
      // первый ключ, когда других администраторов ещё нет.
      let admin;
      const wanted = String(req.body?.username || '').trim();
      if (wanted) {
        admin = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [wanted]).catch(() => null);
        if (!admin) {
          return res.status(404).json({ success: false, message: `Администратор «${wanted}» не заведён` });
        }
      } else {
        admin = await defaultAdmin();
      }
      const existing = await dbAll(`SELECT credential_id, transports FROM admin_credentials WHERE admin_user_id = ?`, [admin.id]).catch(() => []);

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: admin.username || 'SUPER_ADMIN',
        userDisplayName: admin.username || 'SUPER_ADMIN',
        attestationType: 'none',
        excludeCredentials: existing.map(c => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
      });

      const challengeId = putChallenge(options.challenge, { adminUserId: admin.id, kind: 'register' });
      res.json({ success: true, data: { optionsJson: JSON.stringify(options), challengeId } });
    } catch (e) {
      console.error('[Passkey] register/options:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/v1/admin/auth/register/verify', async (req, res) => {
    try {
      const { credentialJson, challengeId, label } = req.body || {};
      const saved = takeChallenge(challengeId);
      if (!saved || saved.kind !== 'register') {
        return res.status(400).json({ success: false, message: 'Челлендж не найден или истёк' });
      }

      const verification = await verifyRegistrationResponse({
        response: typeof credentialJson === 'string' ? JSON.parse(credentialJson) : credentialJson,
        expectedChallenge: saved.challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ success: false, message: 'Ключ не прошёл проверку' });
      }

      const { credential } = verification.registrationInfo;
      await dbRun(
        `INSERT INTO admin_credentials (admin_user_id, credential_id, public_key, counter, transports, label)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [saved.adminUserId, credential.id, b64(credential.publicKey), credential.counter || 0,
         JSON.stringify(credential.transports || []), label || 'passkey']
      );

      // Токен выдаём владельцу ключа, а не «первому админу из таблицы»:
      // иначе любой заведённый ключ входил бы с правами владельца.
      const admin = (await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [saved.adminUserId]).catch(() => null))
        || await defaultAdmin();
      const token = generateAdminJWT(admin);
      console.log(`[Passkey] Зарегистрирован ключ для ${admin.username} (роль ${admin.role || 'SUPER_ADMIN'})`);
      res.json({ success: true, data: { accessToken: token, verified: true, role: admin.role } });
    } catch (e) {
      console.error('[Passkey] register/verify:', e.message);
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // --- Вход -----------------------------------------------------------------

  app.post('/api/v1/admin/auth/login/options', async (req, res) => {
    try {
      const creds = await dbAll(`SELECT credential_id, transports FROM admin_credentials`).catch(() => []);
      if (!creds.length) {
        return res.status(409).json({
          success: false,
          code: 'NO_PASSKEY',
          message: 'Ни одного passkey не зарегистрировано. Откройте /login.html и создайте ключ.'
        });
      }

      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: 'preferred',
        allowCredentials: creds.map(c => ({
          id: c.credential_id,
          transports: c.transports ? JSON.parse(c.transports) : undefined
        }))
      });

      const challengeId = putChallenge(options.challenge, { kind: 'login' });
      res.json({ success: true, data: { optionsJson: JSON.stringify(options), challengeId } });
    } catch (e) {
      console.error('[Passkey] login/options:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/v1/admin/auth/login/verify', async (req, res) => {
    try {
      const { credentialJson, challengeId } = req.body || {};
      const saved = takeChallenge(challengeId);
      if (!saved || saved.kind !== 'login') {
        return res.status(400).json({ success: false, message: 'Челлендж не найден или истёк' });
      }

      const response = typeof credentialJson === 'string' ? JSON.parse(credentialJson) : credentialJson;
      const row = await dbGet(`SELECT * FROM admin_credentials WHERE credential_id = ?`, [response.id]);
      if (!row) return res.status(400).json({ success: false, message: 'Ключ не зарегистрирован' });

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: saved.challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        credential: {
          id: row.credential_id,
          publicKey: Buffer.from(row.public_key, 'base64url'),
          counter: row.counter || 0,
          transports: row.transports ? JSON.parse(row.transports) : undefined
        }
      });

      if (!verification.verified) {
        return res.status(401).json({ success: false, message: 'Подпись не подтверждена' });
      }

      await dbRun(`UPDATE admin_credentials SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [verification.authenticationInfo.newCounter, row.id]);

      const admin = (await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [row.admin_user_id])) || await defaultAdmin();
      const token = generateAdminJWT(admin);
      console.log(`[Passkey] Вход: ${admin.username} (роль ${admin.role || 'SUPER_ADMIN'})`);
      res.json({ success: true, data: { accessToken: token, role: admin.role } });
    } catch (e) {
      console.error('[Passkey] login/verify:', e.message);
      res.status(401).json({ success: false, message: e.message });
    }
  });

  // Сколько ключей заведено — для диагностики и стартового предупреждения.
  app.get('/api/v1/admin/auth/passkeys', async (req, res) => {
    const rows = await dbAll(
      `SELECT c.id, c.label, c.created_at, c.last_used_at,
              c.admin_user_id, u.username, u.role
         FROM admin_credentials c
         LEFT JOIN admin_users u ON u.id = c.admin_user_id`).catch(() => []);
    res.json({ success: true, data: { count: rows.length, rpId: RP_ID, origins: ORIGINS, passkeys: rows } });
  });

  return { credentialCount, RP_ID, ORIGINS };
}

module.exports = { register, RP_ID, ORIGINS };
