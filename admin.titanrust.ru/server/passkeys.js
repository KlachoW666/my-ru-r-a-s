'use strict';

// Existing passkeys remain an optional login method; new accounts use invite/password.

const {
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


/**
 * Какой аутентификатор просить у браузера.
 *
 *   platform       — только встроенный: Windows Hello, Touch ID, Face ID.
 *   cross-platform — только внешний: USB-брелок FIDO2, телефон по QR.
 *   пусто (по умолчанию) — решает операционная система.
 *
 * По умолчанию не указываем ничего: так остаются доступны все способы.
 * Но Windows в этом случае предлагает USB-ключ, если Windows Hello на учётной
 * записи не настроен, — других вариантов у неё нет. Тогда либо настроить Hello,
 * либо поставить platform и получить прямой переход к нему.
 */
const ATTACHMENT = String(process.env.ADMIN_PASSKEY_ATTACHMENT || '').trim();

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

function register({ app, db, dbAll, dbGet, dbRun, generateAdminJWT, requireAdminJWT }) {
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

  // --- Вход -----------------------------------------------------------------

  app.post('/api/v1/admin/auth/login/options', async (req, res) => {
    try {
      const creds = await dbAll(`SELECT credential_id, transports FROM admin_credentials`).catch(() => []);
      if (!creds.length) {
        return res.status(409).json({
          success: false,
          code: 'NO_PASSKEY',
          message: 'Нет зарегистрированных Passkey. Войдите по логину и паролю.'
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

      const admin = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [row.admin_user_id]);
      if (!admin) return res.status(401).json({ success: false, message: 'Доступ отозван' });
      const token = generateAdminJWT(admin);
      console.log(`[Passkey] Вход: ${admin.username} (роль ${admin.role || 'SUPER_ADMIN'})`);
      res.json({ success: true, data: { accessToken: token, role: admin.role } });
    } catch (e) {
      console.error('[Passkey] login/verify:', e.message);
      res.status(401).json({ success: false, message: e.message });
    }
  });

  // Сколько ключей заведено — для диагностики и стартового предупреждения.
  app.get('/api/v1/admin/auth/passkeys', requireAdminJWT, async (req, res) => {
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
