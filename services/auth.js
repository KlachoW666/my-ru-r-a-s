'use strict';

/**
 * Steam OpenID 2.0 авторизация для kaban.gg / titanrust.ru
 *
 * Контракт с фронтом (проверен по собранному бандлу public/assets/js):
 *   1. Кнопка «Войти» делает full-page переход на
 *      /api/v1/auth/steam?tos_accepted=true&is_adult=true&redirect_to=<origin>
 *   2. После Steam мы возвращаем браузер на <redirect_to>/#access_token=<JWT>.
 *      store.handleSteamCallback() читает hash, кладёт токен в localStorage["token"]
 *      и чистит URL (см. store-DveOaq2e.js).
 *   3. При следующих загрузках SPA зовёт GET /api/v1/auth/refresh и ждёт
 *      { data: { accessToken } } — токен восстанавливается из httpOnly-cookie.
 *   4. Все запросы идут с заголовком Authorization: Bearer <accessToken>.
 *
 * Внешних зависимостей нет: JWT подписывается через crypto (HS256),
 * OpenID-верификация — через https.
 */

const crypto = require('crypto');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();

const { ADMIN_DB_PATH, getSteamPlayerSummary } = require('./steamSync');
const { registerEmailRoutes } = require('./emailAuth');

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

const IS_PROD = process.env.NODE_ENV === 'production';

/** Канонический публичный адрес. Именно он уходит в Steam как realm. */
const PUBLIC_URL = String(process.env.PUBLIC_URL || 'https://titanrust.ru').replace(/\/+$/, '');

/** Куда Steam вернёт браузер. Должен лежать внутри realm. */
const STEAM_RETURN_URL = `${PUBLIC_URL}/api/v1/auth/steam/return`;

const JWT_SECRET = process.env.JWT_SECRET || 'titanrust_super_secret_jwt_key_2026';

// Небезопасный секрет по умолчанию. Если .env не подхватился на проде, сервер
// поднялся бы молча на общеизвестном значении, и подделать токен смог бы любой,
// кто видел репозиторий. Поэтому в production падаем сразу.
const INSECURE_JWT_SECRETS = ['titanrust_super_secret_jwt_key_2026', '', 'secret', 'changeme'];
if (process.env.NODE_ENV === 'production' && INSECURE_JWT_SECRETS.includes(JWT_SECRET)) {
  console.error('[FATAL] JWT_SECRET не задан или оставлен значением по умолчанию.');
  console.error('        Сгенерируйте: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.error('        и пропишите в .env, иначе токены можно подделать.');
  process.exit(1);
}

const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL || 60 * 60);            // 1 час
const REFRESH_TTL = Number(process.env.REFRESH_TOKEN_TTL || 30 * 24 * 60 * 60); // 30 дней
const REFRESH_COOKIE = 'kaban_rt';

/** Домен для cookie: .titanrust.ru покрывает www и поддомены. */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || (IS_PROD ? '.titanrust.ru' : undefined);

/** Куда разрешено редиректить после логина; он же список origin'ов для CORS. */
const ALLOWED_ORIGINS = new Set(
  [
    PUBLIC_URL,
    'https://titanrust.ru',
    'https://www.titanrust.ru',
    // Второй домен проекта: админка ходит в ту же базу, но через свой сервер.
    // В списке нужен, чтобы её запросы к игровому API не резались CORS.
    'https://admin.titanrust.ru',
    ...(IS_PROD
      ? []
      : ['http://localhost:3101', 'http://localhost:3030', 'http://127.0.0.1:3101', 'http://127.0.0.1:3030']),
    ...String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ].map((o) => o.replace(/\/+$/, ''))
);

/** Разрешить моковый профиль без токена (только для локальной разработки). */
const ALLOW_MOCK_AUTH = process.env.ALLOW_MOCK_AUTH === '1' || !IS_PROD;

// ---------------------------------------------------------------------------
// JWT (HS256) на голом crypto — jsonwebtoken в корневых зависимостях нет
// ---------------------------------------------------------------------------

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function signJWT(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(data).digest());
  return `${data}.${sig}`;
}

function verifyJWT(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const chunk of raw.split(';')) {
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    if (chunk.slice(0, idx).trim() === name) {
      return decodeURIComponent(chunk.slice(idx + 1).trim());
    }
  }
  return null;
}

function cookieOptions(maxAgeMs) {
  const opts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    path: '/',
    maxAge: maxAgeMs
  };
  if (COOKIE_DOMAIN) opts.domain = COOKIE_DOMAIN;
  return opts;
}

// ---------------------------------------------------------------------------
// Steam OpenID 2.0
// ---------------------------------------------------------------------------

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const STEAM_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

function buildSteamLoginUrl(returnTo) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': PUBLIC_URL,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

/**
 * Просим Steam подтвердить подпись. Подписью накрыт и openid.return_to,
 * поэтому подменить redirect_to в обратной ссылке нельзя — проверка упадёт.
 */
function verifySteamAssertion(query) {
  return new Promise((resolve) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith('openid.')) body.append(key, String(value));
    }
    body.set('openid.mode', 'check_authentication');
    const payload = body.toString();

    const req = https.request(
      STEAM_OPENID_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'kaban.gg-auth'
        },
        timeout: 10000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (!/is_valid\s*:\s*true/i.test(data)) return resolve(null);
          const claimed = String(query['openid.claimed_id'] || '');
          const m = claimed.match(STEAM_ID_RE);
          resolve(m ? m[1] : null);
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('steam openid timeout')));
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Хранилище пользователей (та же SQLite, что у админки)
// ---------------------------------------------------------------------------

function openDb() {
  try {
    return new sqlite3.Database(ADMIN_DB_PATH);
  } catch {
    return null;
  }
}

function run(db, sql, params = []) {
  return new Promise((resolve) => {
    db.run(sql, params, function (err) {
      resolve(err ? null : { lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve) => db.get(sql, params, (err, row) => resolve(err ? null : row)));
}

let schemaReady = false;

/**
 * Таблицу users создаёт админка; здесь мы только доливаем колонки, которых
 * ей не хватает для Steam-логина. Все ALTER идемпотентны — повторный запуск
 * просто получит ошибку «duplicate column» и проглотит её.
 */
async function ensureAuthSchema() {
  if (schemaReady) return;
  const db = openDb();
  if (!db) return;

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT, steam_id TEXT, balance REAL DEFAULT 0.0,
       rtp REAL DEFAULT 95.0, role TEXT DEFAULT 'user',
       status TEXT DEFAULT 'active',
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`
  );
  for (const col of [
    `avatar TEXT`,
    `avatar_full TEXT`,
    `profile_url TEXT`,
    `trade_link TEXT`,
    `currency TEXT DEFAULT 'RUB'`,
    `last_login_at TIMESTAMP`
  ]) {
    await run(db, `ALTER TABLE users ADD COLUMN ${col}`);
  }
  await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_steam_id ON users(steam_id)`);

  db.close();
  schemaReady = true;
}

async function upsertSteamUser(steamId, summary) {
  await ensureAuthSchema();
  const db = openDb();
  if (!db) {
    // База недоступна — работаем без персистентности, но логин не ломаем.
    return {
      id: steamId,
      steam_id: steamId,
      username: summary?.personaname || `Player${steamId.slice(-5)}`,
      avatar: summary?.avatarmedium || null,
      avatar_full: summary?.avatarfull || null,
      profile_url: summary?.profileurl || null,
      balance: 0,
      role: 'user',
      status: 'active'
    };
  }

  const name = summary?.personaname || `Player${steamId.slice(-5)}`;
  const avatar = summary?.avatarmedium || summary?.avatar || null;
  const avatarFull = summary?.avatarfull || avatar;
  const profileUrl = summary?.profileurl || null;

  const existing = await get(db, `SELECT * FROM users WHERE steam_id = ?`, [steamId]);
  if (existing) {
    await run(
      db,
      `UPDATE users SET username = ?, avatar = ?, avatar_full = ?, profile_url = ?,
              last_login_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name, avatar, avatarFull, profileUrl, existing.id]
    );
  } else {
    await run(
      db,
      `INSERT INTO users (username, steam_id, balance, rtp, role, status, avatar, avatar_full, profile_url, last_login_at)
       VALUES (?, ?, 0.0, 95.0, 'user', 'active', ?, ?, ?, CURRENT_TIMESTAMP)`,
      [name, steamId, avatar, avatarFull, profileUrl]
    );
  }

  const row = await get(db, `SELECT * FROM users WHERE steam_id = ?`, [steamId]);
  db.close();
  return row;
}

async function getUserById(id) {
  const db = openDb();
  if (!db) return null;
  const row = await get(db, `SELECT * FROM users WHERE id = ?`, [id]);
  db.close();
  return row;
}

/** Форма профиля, которую ждёт фронт от GET /api/v1/user. */
function toPublicUser(row) {
  if (!row) return null;
  const id = String(row.userId ?? row.id ?? '');
  const steamId = row.steam_id ?? row.steamId ?? null;
  const displayName = row.displayName || row.username || row.name || 'Player';
  const tradeUrl = row.trade_url ?? row.trade_link ?? row.tradeUrl ?? row.tradeLink ?? null;
  const email = row.email || null;
  const linkedProviders = Array.isArray(row.linkedProviders)
    ? [...new Set(row.linkedProviders)]
    : [steamId ? 'steam' : null, email ? 'email' : null].filter(Boolean);
  const avatar = row.avatar || '/avatars/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg';
  return {
    // The current compiled store consumes these names. Keep the legacy names
    // below because older chunks and the admin adapter still read them.
    userId: id,
    publicId: String(row.publicId ?? id),
    displayName,
    id,
    steamId,
    username: displayName,
    name: displayName,
    avatar,
    avatarFull: row.avatar_full || avatar,
    profileUrl: row.profile_url || null,
    balance: Number(row.balance || 0),
    currency: row.currency || 'RUB',
    status: row.status || 'active',
    role: row.role || 'user',
    isGuest: Boolean(row.isGuest),
    email,
    emailVerified: row.emailVerified ?? row.email_verified === 1,
    linkedProviders,
    tradeUrl,
    tradeLink: tradeUrl,
    hiddenFromPublicTops: Boolean(row.hiddenFromPublicTops ?? row.hidden_from_public_tops),
    wagerRemaining: Number(row.wagerRemaining ?? row.wager_remaining ?? 0),
    depositBlocked: Boolean(row.depositBlocked ?? row.deposit_blocked),
    withdrawBlocked: Boolean(row.withdrawBlocked ?? row.withdraw_blocked),
    betBlocked: Boolean(row.betBlocked ?? row.bet_blocked),
    isUserAdmin: row.role === 'admin' || row.role === 'SUPER_ADMIN',
    canAccessStreamerStatistics: row.role === 'admin' || row.role === 'SUPER_ADMIN',
    createdAt: row.created_at || new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Кладёт в req.auth расшифрованный payload, если пришёл валидный Bearer.
 * Ничего не блокирует — решение принимает конкретный роут.
 */
function attachAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  req.auth = verifyJWT(token);
  next();
}

function requireAuth(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ status: 'error', message: 'Требуется авторизация' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Роуты
// ---------------------------------------------------------------------------

function safeRedirectTarget(candidate) {
  if (!candidate) return PUBLIC_URL;
  try {
    const url = new URL(candidate);
    const origin = url.origin.replace(/\/+$/, '');
    return ALLOWED_ORIGINS.has(origin) ? origin : PUBLIC_URL;
  } catch {
    return PUBLIC_URL;
  }
}

/**
 * Единая выдача сессии: refresh в httpOnly-cookie, access — в ответе.
 * Одна и та же и для Steam, и для входа по e-mail, чтобы фронт не различал их.
 */
function issueSession(res, user) {
  const claims = {
    sub: String(user.id),
    steamId: user.steamId || null,
    username: user.username,
    role: user.role || 'user'
  };
  const accessToken = signJWT(claims, ACCESS_TTL);
  const refreshToken = signJWT({ ...claims, typ: 'refresh' }, REFRESH_TTL);
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(REFRESH_TTL * 1000));
  return { accessToken, refreshToken };
}

function registerAuthRoutes(app, options = {}) {
  const mockUser = options.mockUser || null;

  // attachAuth подключается в server.js до всех роутов — здесь он не нужен.

  // --- Шаг 1: уходим в Steam -----------------------------------------------
  app.get('/api/v1/auth/steam', (req, res) => {
    const target = safeRedirectTarget(req.query.redirect_to);
    // redirect_to едет внутри return_to: Steam подписывает return_to целиком,
    // поэтому подменить его по дороге не получится.
    const returnTo = `${STEAM_RETURN_URL}?rt=${encodeURIComponent(target)}`;
    res.redirect(302, buildSteamLoginUrl(returnTo));
  });

  // --- Шаг 2: Steam вернул браузер ------------------------------------------
  app.get('/api/v1/auth/steam/return', async (req, res) => {
    const target = safeRedirectTarget(req.query.rt);

    try {
      const steamId = await verifySteamAssertion(req.query);
      if (!steamId) {
        console.warn('[auth] Steam OpenID: подпись не подтверждена');
        return res.redirect(302, `${target}/?auth_error=steam_verification_failed`);
      }

      const summary = await getSteamPlayerSummary(steamId).catch(() => null);
      const user = await upsertSteamUser(steamId, summary);

      const claims = { sub: String(user.id), steamId, username: user.username, role: user.role || 'user' };
      const accessToken = signJWT(claims, ACCESS_TTL);
      const refreshToken = signJWT({ ...claims, typ: 'refresh' }, REFRESH_TTL);

      res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(REFRESH_TTL * 1000));

      console.log(`[auth] Steam login: ${user.username} (${steamId})`);
      // Именно hash — SPA читает его в handleSteamCallback().
      return res.redirect(302, `${target}/#access_token=${encodeURIComponent(accessToken)}`);
    } catch (e) {
      console.error('[auth] steam/return error:', e.message);
      return res.redirect(302, `${target}/?auth_error=internal`);
    }
  });

  // --- Обновление access-токена ---------------------------------------------
  app.get('/api/v1/auth/refresh', (req, res) => {
    const payload = verifyJWT(readCookie(req, REFRESH_COOKIE));
    if (!payload || payload.typ !== 'refresh') {
      if (ALLOW_MOCK_AUTH && mockUser) {
        const token = signJWT({ sub: String(mockUser.id), username: mockUser.username, role: 'user', mock: true }, ACCESS_TTL);
        return res.json({ status: 'success', data: { accessToken: token } });
      }
      return res.status(401).json({ status: 'error', message: 'Сессия не найдена' });
    }
    const { sub, steamId, username, role } = payload;
    const accessToken = signJWT({ sub, steamId, username, role }, ACCESS_TTL);
    res.json({ status: 'success', data: { accessToken } });
  });

  // --- Текущий профиль -------------------------------------------------------
  app.get('/api/v1/auth/me', async (req, res) => {
    const user = await currentUser(req, mockUser);
    if (!user) return res.status(401).json({ status: 'error', message: 'Требуется авторизация' });
    res.json({ status: 'success', data: { user } });
  });

  // --- Выход -----------------------------------------------------------------
  app.all('/api/v1/auth/logout', (req, res) => {
    const opts = cookieOptions(0);
    delete opts.maxAge;
    res.clearCookie(REFRESH_COOKIE, opts);
    res.json({ status: 'success', message: 'Выход выполнен' });
  });

  // Вход и регистрация по e-mail — services/emailAuth.js.
  // Сессию выдаёт та же issueSession, что и Steam, поэтому форма ответа и
  // refresh-cookie одинаковые для обоих способов входа.
  registerEmailRoutes(app, {
    openDb,
    run,
    get,
    toPublicUser,
    issueSession: (res, user) => issueSession(res, {
      id: user.id,
      steamId: user.steam_id || null,
      username: user.username,
      role: user.role || 'user'
    })
  });
}

/**
 * Профиль неавторизованного посетителя.
 *
 * ВАЖНО: /api/v1/user НЕЛЬЗЯ отдавать с 401. Собранный фронт дёргает эту ручку
 * на старте безусловно (без enabled-гейта), а его перехватчик 401 в
 * mutator-*.js заканчивается так:
 *     await logout(); openAuthModal(); return new Promise(()=>{})
 * Этот промис не резолвится никогда и держит навсегда захваченным веб-лок
 * "kaban.auth-refresh". Итог — splash-экран крутится вечно.
 * Поэтому гостю отдаём 200 с пустым профилем; факт «залогинен или нет» фронт
 * определяет по наличию localStorage["token"], а не по этому ответу.
 */
function guestUser() {
  return toPublicUser({
    id: '',
    username: 'Гость',
    avatar: '/avatars/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg',
    balance: 0,
    status: 'guest',
    role: 'guest',
    isGuest: true,
    createdAt: new Date(0).toISOString()
  });
}

/** Профиль по текущему запросу; в dev без токена — мок. */
async function currentUser(req, mockUser) {
  if (req.auth && !req.auth.mock) {
    const row = await getUserById(req.auth.sub);
    if (row) return toPublicUser(row);
    // Пользователь есть в токене, но пропал из БД — отдаём то, что в токене.
    return toPublicUser({ id: req.auth.sub, steam_id: req.auth.steamId, username: req.auth.username, role: req.auth.role });
  }
  return ALLOW_MOCK_AUTH ? toPublicUser(mockUser) : null;
}

module.exports = {
  ALLOWED_ORIGINS,
  registerAuthRoutes,
  issueSession,
  attachAuth,
  requireAuth,
  currentUser,
  guestUser,
  signJWT,
  verifyJWT,
  toPublicUser,
  ensureAuthSchema,
  PUBLIC_URL,
  ALLOW_MOCK_AUTH
};
