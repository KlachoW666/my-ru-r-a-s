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

  // --- Приглашения ----------------------------------------------------------
  //
  // Экран /register в бандле устроен так (RegisterPage-CD3vNTJK.js):
  //   token = route.query.token
  //   validateInvite(token) -> GET /auth/invite/validate?token=
  //                            ждёт { valid, targetRole, createdBy, expiresAt }
  //   registerWithPasskey   -> POST /auth/register/options { inviteToken }
  //                            POST /auth/register/verify  { credentialJson,
  //                              challengeId, inviteToken, displayName }
  //
  // Без токена в ссылке форма не показывается вовсе — поэтому одного
  // ADMIN_INVITE_CODE мало, нужны именно одноразовые токены со сроком.
  db.run(`CREATE TABLE IF NOT EXISTS admin_invites (
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

  /** Живое приглашение: существует, не использовано, не просрочено. */
  async function findInvite(token) {
    if (!token) return null;
    const row = await dbGet(`SELECT * FROM admin_invites WHERE token = ?`, [String(token)]).catch(() => null);
    if (!row) return null;
    if (row.used_at) return null;
    // Сравниваем как время, а не строки: в базе форматы дат разные
    // (CURRENT_TIMESTAMP даёт «2026-08-25 13:55:32», toISOString — с «T» и «Z»),
    // и строковое сравнение здесь врёт.
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
    return row;
  }

  app.get('/api/v1/admin/auth/invite/validate', async (req, res) => {
    const row = await findInvite(req.query.token);
    if (!row) {
      // valid:false, а не 404: фронт показывает по этому полю понятное
      // «Приглашение недействительно или истекло».
      return res.json({ success: true, data: { valid: false, targetRole: '', createdBy: '', expiresAt: '' } });
    }
    res.json({
      success: true,
      data: {
        valid: true,
        targetRole: row.target_role || 'VIEWER',
        createdBy: row.created_by || 'SUPER_ADMIN',
        expiresAt: row.expires_at || ''
      }
    });
  });

  // --- Регистрация ключа ----------------------------------------------------

  /**
   * Кому принадлежит будущий ключ.
   *
   * Три пути, по убыванию строгости:
   *   1. inviteToken — одноразовое приглашение; роль и учётка берутся из него.
   *      Так ходит фронт.
   *   2. inviteCode  — общий ADMIN_INVITE_CODE из .env; учётку указывают
   *      через username. Остался для curl и совместимости.
   *   3. ни того ни другого — разрешено, только пока в базе нет ни одного
   *      ключа: иначе админку не поднять с нуля.
   */
  async function resolveTarget(body) {
    const count = await credentialCount();
    const inviteToken = String(body?.inviteToken || body?.token || '').trim();

    if (inviteToken) {
      const invite = await findInvite(inviteToken);
      if (!invite) return { error: 404, message: 'Приглашение недействительно или истекло' };

      // Учётка из приглашения: либо уже заведена, либо создаём её сейчас.
      let admin = null;
      if (invite.admin_user_id) {
        admin = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [invite.admin_user_id]).catch(() => null);
      }
      if (!admin && invite.username) {
        admin = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [invite.username]).catch(() => null);
      }
      if (!admin) {
        const name = invite.username || `admin-${invite.id}`;
        const r = await dbRun(`INSERT INTO admin_users (username, role) VALUES (?, ?)`,
          [name, invite.target_role || 'VIEWER']).catch(() => null);
        if (!r) return { error: 409, message: 'Не удалось завести учётную запись' };
        admin = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [r.lastID]);
        console.log(`[Passkey] По приглашению заведён ${name} с ролью ${invite.target_role}`);
      }
      return { admin, invite };
    }

    if (count > 0) {
      const code = String(body?.inviteCode || body?.invite || '');
      if (!INVITE_CODE || code !== INVITE_CODE) {
        return { error: 403, message: 'Нужно приглашение: ссылка с токеном либо действующий ADMIN_INVITE_CODE' };
      }
      const wanted = String(body?.username || '').trim();
      if (wanted) {
        const admin = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [wanted]).catch(() => null);
        if (!admin) return { error: 404, message: `Администратор «${wanted}» не заведён` };
        return { admin, invite: null };
      }
      return { admin: await defaultAdmin(), invite: null };
    }

    // Ключей нет вовсе — первый уходит владельцу.
    return { admin: await defaultAdmin(), invite: null };
  }

  app.post('/api/v1/admin/auth/register/options', async (req, res) => {
    try {
      const target = await resolveTarget(req.body);
      if (target.error) {
        return res.status(target.error).json({ success: false, message: target.message });
      }
      const admin = target.admin;
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

      const challengeId = putChallenge(options.challenge, {
        adminUserId: admin.id, kind: 'register',
        inviteId: target.invite ? target.invite.id : null
      });
      res.json({ success: true, data: { optionsJson: JSON.stringify(options), challengeId } });
    } catch (e) {
      console.error('[Passkey] register/options:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/v1/admin/auth/register/verify', async (req, res) => {
    try {
      const { credentialJson, challengeId, label, displayName } = req.body || {};
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
         JSON.stringify(credential.transports || []),
         // Фронт присылает название ключа в displayName («MacBook Touch ID»).
         displayName || label || 'passkey']
      );

      // Приглашение одноразовое: гасим сразу после успешной проверки ключа,
      // а не при выдаче челленджа — иначе прерванная регистрация сожгла бы его.
      if (saved.inviteId) {
        await dbRun(`UPDATE admin_invites SET used_at = CURRENT_TIMESTAMP, admin_user_id = ? WHERE id = ?`,
          [saved.adminUserId, saved.inviteId]).catch(() => {});
      }

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
