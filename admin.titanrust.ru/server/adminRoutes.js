'use strict';

/**
 * Разделы админки: список, создание, изменение, удаление.
 *
 * Раньше 29 из 59 эндпоинтов не имели роутов вообще и проваливались в
 * `app.all('/api/v1/admin/*')`, который отвечает `{success:true, data:[]}` —
 * страницы открывались пустыми и ничего не сохраняли. Ещё 8 отдавали
 * захардкоженный объект.
 *
 * ВАЖНО: этот модуль подключается ДО catch-all. Express берёт первый совпавший
 * обработчик, поэтому всё, объявленное после него, не вызывается никогда.
 */

const crypto = require('crypto');
const access = require('./adminAccess');

function makeAdminRoutes({ app, dbAll, dbGet, dbRun, requireAdminJWT }) {
  const ok = (res, data, extra = {}) => res.json({ success: true, data, items: Array.isArray(data) ? data : undefined, ...extra });
  const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });

  // ---------------------------------------------------------------------------
  // Универсальный CRUD
  // ---------------------------------------------------------------------------

  /**
   * @param path     путь после /api/v1/admin
   * @param table    таблица в SQLite
   * @param fields   какие поля разрешено писать из тела запроса
   * @param opts.search   колонки для поиска по ?search=
   * @param opts.order    сортировка по умолчанию
   * @param opts.map      преобразование строки перед отдачей
   * @param opts.filters  { queryParam: column } для фильтрации
   */
  function resource(path, table, fields, opts = {}) {
    const order = opts.order || 'id DESC';
    const map = opts.map || ((r) => r);

    app.get(`/api/v1/admin${path}`, requireAdminJWT, async (req, res) => {
      try {
        const where = [];
        const params = [];

        for (const [q, col] of Object.entries(opts.filters || {})) {
          if (req.query[q] != null && req.query[q] !== '' && req.query[q] !== 'all') {
            where.push(`${col} = ?`);
            params.push(req.query[q]);
          }
        }
        if (req.query.search && (opts.search || []).length) {
          where.push('(' + opts.search.map(c => `${c} LIKE ?`).join(' OR ') + ')');
          opts.search.forEach(() => params.push(`%${req.query.search}%`));
        }

        const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = ((parseInt(req.query.page) || 1) - 1) * limit;

        const total = (await dbGet(`SELECT COUNT(*) AS c FROM ${table}${sql}`, params))?.c || 0;
        const rows = await dbAll(
          `SELECT * FROM ${table}${sql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);

        const data = rows.map(map);
        res.json({
          success: true, data, items: data, total,
          pagination: { page: parseInt(req.query.page) || 1, limit, total }
        });
      } catch (e) { bad(res, e.message, 500); }
    });

    app.get(`/api/v1/admin${path}/:id`, requireAdminJWT, async (req, res) => {
      try {
        const row = await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
        if (!row) return bad(res, 'Запись не найдена', 404);
        ok(res, map(row));
      } catch (e) { bad(res, e.message, 500); }
    });

    app.post(`/api/v1/admin${path}`, requireAdminJWT, async (req, res) => {
      try {
        const body = req.body || {};
        const cols = fields.filter(f => body[f] !== undefined);
        if (!cols.length) return bad(res, 'Пустое тело запроса');
        const r = await dbRun(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
          cols.map(c => body[c]));
        const row = await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [r.lastID]);
        ok(res, map(row));
      } catch (e) { bad(res, e.message, 500); }
    });

    const update = async (req, res) => {
      try {
        const body = req.body || {};
        const cols = fields.filter(f => body[f] !== undefined);
        if (!cols.length) return bad(res, 'Нечего обновлять');
        await dbRun(
          `UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
          [...cols.map(c => body[c]), req.params.id]);
        const row = await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
        if (!row) return bad(res, 'Запись не найдена', 404);
        ok(res, map(row));
      } catch (e) { bad(res, e.message, 500); }
    };
    app.put(`/api/v1/admin${path}/:id`, requireAdminJWT, update);
    app.patch(`/api/v1/admin${path}/:id`, requireAdminJWT, update);

    app.delete(`/api/v1/admin${path}/:id`, requireAdminJWT, async (req, res) => {
      try {
        const r = await dbRun(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
        if (!r.changes) return bad(res, 'Запись не найдена', 404);
        res.json({ success: true, deleted: req.params.id });
      } catch (e) { bad(res, e.message, 500); }
    });
  }

  // ---------------------------------------------------------------------------
  // Настройки (key/value)
  // ---------------------------------------------------------------------------

  async function readSetting(key, fallback = {}) {
    const row = await dbGet(`SELECT value FROM app_settings WHERE key = ?`, [key]).catch(() => null);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  async function writeSetting(key, value) {
    await dbRun(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, JSON.stringify(value)]);
    return value;
  }

  /** GET отдаёт настройку, PUT/POST сохраняет присланный объект целиком. */
  function settings(path, key) {
    app.get(`/api/v1/admin${path}`, requireAdminJWT, async (req, res) => ok(res, await readSetting(key)));
    const save = async (req, res) => {
      const current = await readSetting(key);
      const next = { ...current, ...(req.body || {}) };
      ok(res, await writeSetting(key, next));
    };
    app.put(`/api/v1/admin${path}`, requireAdminJWT, save);
    app.post(`/api/v1/admin${path}`, requireAdminJWT, save);
    app.patch(`/api/v1/admin${path}`, requireAdminJWT, save);
  }

  const DEPOSIT_TIER_NAMES = ['Камень', 'Лук', 'Двушка', 'Томпсон', 'Калаш'];
  const DEPOSIT_GROUPS = ['B', 'C', 'D'];

  function normalizeDepositChainConfig(value = {}) {
    const sourceTiers = Array.isArray(value.tiers) ? value.tiers : [];
    const byIndex = new Map(sourceTiers.map((tier, index) => [Number.isInteger(Number(tier?.tierIndex)) ? Number(tier.tierIndex) : index, tier || {}]));
    const tiers = DEPOSIT_TIER_NAMES.map((name, tierIndex) => {
      const tier = byIndex.get(tierIndex) || {};
      return { tierIndex, threshold: Number(tier.threshold) || 0, name: tier.name || name };
    });
    const seen = new Set();
    const caseRefs = [];
    for (const row of Array.isArray(value.caseRefs) ? value.caseRefs : []) {
      const group = String(row?.group || '').toUpperCase();
      const tierIndex = Number(row?.tierIndex);
      const caseRef = String(row?.caseRef || row?.caseSlug || '').trim();
      const key = `${group}:${tierIndex}`;
      if (!DEPOSIT_GROUPS.includes(group) || !Number.isInteger(tierIndex) || tierIndex < 0 || tierIndex > 4 || !caseRef || seen.has(key)) continue;
      seen.add(key);
      caseRefs.push({ group, tierIndex, caseRef });
    }
    return { ...value, variant: DEPOSIT_GROUPS.includes(value.variant) ? value.variant : 'B', tiers, caseRefs };
  }

  function depositChainSettings() {
    app.get('/api/v1/admin/config/deposit-chain', requireAdminJWT, async (_req, res) => {
      const row = await dbGet(`SELECT value, updated_at FROM app_settings WHERE key = 'deposit_chain'`).catch(() => null);
      let value = {};
      try { value = row ? JSON.parse(row.value) : {}; } catch {}
      ok(res, { ...normalizeDepositChainConfig(value), updatedAt: row?.updated_at || null, updatedBy: value.updatedBy || null });
    });

    const save = async (req, res) => {
      const body = req.body || {};
      const tiers = Array.isArray(body.tiers) ? body.tiers : [];
      const caseRefs = Array.isArray(body.caseRefs) ? body.caseRefs : [];
      const indexes = new Set(tiers.map(tier => Number(tier?.tierIndex)));
      if (tiers.length !== 5 || indexes.size !== 5 || [...indexes].some(index => !Number.isInteger(index) || index < 0 || index > 4)) {
        return bad(res, 'Нужны ровно пять тиров с индексами 0–4');
      }
      const thresholds = [...tiers]
        .sort((a, b) => Number(a.tierIndex) - Number(b.tierIndex))
        .map(tier => Number(tier.threshold));
      if (thresholds.some(threshold => !Number.isFinite(threshold) || threshold < 0)) {
        return bad(res, 'Порог каждого тира должен быть неотрицательным числом');
      }
      if (thresholds.some((threshold, index) => index > 0 && threshold <= thresholds[index - 1])) {
        return bad(res, 'Пороги тиров должны строго возрастать');
      }
      const expectedCells = DEPOSIT_GROUPS.length * 5;
      const cells = new Set(caseRefs.map(row => `${String(row?.group || '').toUpperCase()}:${Number(row?.tierIndex)}`));
      if (caseRefs.length !== expectedCells || cells.size !== expectedCells || [...cells].some(cell => !/^[BCD]:[0-4]$/.test(cell))) {
        return bad(res, 'Заполните все кейсы для групп B, C и D');
      }
      const slugs = [...new Set(caseRefs.map(row => String(row?.caseRef || '').trim()).filter(Boolean))];
      const placeholders = slugs.map(() => '?').join(',');
      const rows = slugs.length ? await dbAll(
        `SELECT c.slug, COUNT(ci.item_id) AS item_count
         FROM cases c LEFT JOIN case_items ci ON ci.case_id = c.id
         LEFT JOIN items i ON i.id = ci.item_id
         WHERE c.slug IN (${placeholders}) AND c.exclusiveTo = 'DEPOSIT_CHAIN'
           AND c.status = 'active' AND c.isActive = 1 AND c.archived = 0
           AND (i.id IS NULL OR (COALESCE(i.delisted,0) = 0 AND COALESCE(i.admin_disabled,0) = 0))
         GROUP BY c.id`, slugs) : [];
      const valid = new Set(rows.filter(row => Number(row.item_count) >= 2).map(row => row.slug));
      const rejected = slugs.filter(slug => !valid.has(slug));
      if (rejected.length) {
        const message = `Кейсы должны быть активными, иметь минимум два предмета и эксклюзивность DEPOSIT_CHAIN: ${rejected.join(', ')}`;
        return res.status(409).json({ success: false, message, error: { message } });
      }
      const current = normalizeDepositChainConfig(await readSetting('deposit_chain', {}));
      const next = normalizeDepositChainConfig({
        ...current,
        tiers: tiers.map(tier => ({
          tierIndex: Number(tier.tierIndex),
          threshold: Number(tier.threshold),
          name: current.tiers[Number(tier.tierIndex)]?.name || DEPOSIT_TIER_NAMES[Number(tier.tierIndex)]
        })),
        caseRefs: caseRefs.map(row => ({ group: String(row.group).toUpperCase(), tierIndex: Number(row.tierIndex), caseRef: String(row.caseRef).trim() })),
        updatedBy: String(req.user?.username || req.user?.userId || 'admin')
      });
      await writeSetting('deposit_chain', next);
      ok(res, { ...next, updatedAt: new Date().toISOString() });
    };
    app.put('/api/v1/admin/config/deposit-chain', requireAdminJWT, save);
    app.post('/api/v1/admin/config/deposit-chain', requireAdminJWT, save);
    app.patch('/api/v1/admin/config/deposit-chain', requireAdminJWT, save);
  }

  /** То же, что resource(), но идентификатор строковый и генерируется клиентом. */
  function textIdResource(path, table, fields) {
    app.get(`/api/v1/admin${path}`, requireAdminJWT, async (req, res) => {
      const rows = await dbAll(`SELECT * FROM ${table} ORDER BY rowid ASC`).catch(() => []);
      res.json({ success: true, data: rows, items: rows, total: rows.length });
    });

    const save = async (req, res) => {
      const body = req.body || {};
      const cols = fields.filter(f => body[f] !== undefined);
      if (!cols.length) return bad(res, 'Нечего обновлять');
      const r = await dbRun(
        `UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...cols.map(c => body[c]), req.params.id]);
      if (!r.changes) {
        // Строки нет — создаём: так «сохранить» работает и для новых записей.
        await dbRun(`INSERT INTO ${table} (id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`,
          [req.params.id, ...cols.map(c => body[c])]).catch(() => {});
      }
      ok(res, await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]));
    };
    app.put(`/api/v1/admin${path}/:id`, requireAdminJWT, save);
    app.patch(`/api/v1/admin${path}/:id`, requireAdminJWT, save);

    app.post(`/api/v1/admin${path}`, requireAdminJWT, async (req, res) => {
      const body = req.body || {};
      if (!body.id) return bad(res, 'Не указан идентификатор');
      const cols = fields.filter(f => body[f] !== undefined);
      await dbRun(`INSERT INTO ${table} (id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`,
        [body.id, ...cols.map(c => body[c])]);
      ok(res, await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [body.id]));
    });

    app.delete(`/api/v1/admin${path}/:id`, requireAdminJWT, async (req, res) => {
      const r = await dbRun(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
      if (!r.changes) return bad(res, 'Запись не найдена', 404);
      res.json({ success: true, deleted: req.params.id });
    });
  }

  // ===========================================================================
  // АДМИНИСТРАТОРЫ И РОЛИ
  // ===========================================================================
  //
  // Раздел закрыт ролевой моделью: домен `admins` доступен на запись только
  // владельцу (SUPER_ADMIN), администратору — на чтение, остальным — никак.
  // Проверка стоит в requireAdminJWT, здесь остаются только смысловые запреты:
  // не остаться без единого владельца и не разжаловать самого себя.

  const adminView = (r) => r && ({
    id: r.id,
    username: r.username,
    email: r.email,
    role: access.normalizeRole(r.role),
    roleTitle: access.ROLES[access.normalizeRole(r.role)].title,
    created_at: r.created_at
    // password намеренно не отдаём: колонка осталась от прежнего входа,
    // сейчас вход только по passkey.
  });

  async function passkeyCounts() {
    const rows = await dbAll(
      `SELECT admin_user_id AS id, COUNT(*) AS c FROM admin_credentials GROUP BY admin_user_id`
    ).catch(() => []);
    return new Map(rows.map(r => [r.id, r.c]));
  }

  async function superAdminCount(exceptId = null) {
    const rows = await dbAll(`SELECT id, role FROM admin_users`).catch(() => []);
    return rows.filter(r => access.normalizeRole(r.role) === 'SUPER_ADMIN' && r.id !== exceptId).length;
  }

  app.get('/api/v1/admin/admins', requireAdminJWT, async (req, res) => {
    try {
      const rows = await dbAll(`SELECT * FROM admin_users ORDER BY id ASC`);
      const keys = await passkeyCounts();
      const data = rows.map(r => ({ ...adminView(r), passkeys: keys.get(r.id) || 0 }));
      res.json({ success: true, data, items: data, total: data.length, roles: access.roleCatalog() });
    } catch (e) { bad(res, e.message, 500); }
  });

  // Литеральный путь — строго до /admins/:id, иначе Express примет "roles" за id.
  app.get('/api/v1/admin/admins/roles', requireAdminJWT, (req, res) =>
    ok(res, access.roleCatalog()));

  // Выписанные приглашения — чтобы видеть, кто ещё не завёл ключ.
  app.get('/api/v1/admin/admins/invites', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(
      `SELECT id, target_role, username, created_by, created_at, expires_at, used_at
         FROM admin_invites ORDER BY id DESC LIMIT 100`).catch(() => []);
    // Сам токен не отдаём: он пропуск, и светить его в списке незачем.
    ok(res, rows.map(r => ({
      ...r,
      status: r.used_at ? 'использовано'
        : (r.expires_at && Date.parse(r.expires_at) < Date.now() ? 'истекло' : 'ждёт')
    })));
  });


  app.get('/api/v1/admin/admins/:id', requireAdminJWT, async (req, res) => {
    const row = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [req.params.id]);
    if (!row) return bad(res, 'Администратор не найден', 404);
    const keys = await passkeyCounts();
    ok(res, { ...adminView(row), passkeys: keys.get(row.id) || 0 });
  });

  app.post('/api/v1/admin/admins', requireAdminJWT, async (req, res) => {
    try {
      const body = req.body || {};
      const username = String(body.username || '').trim();
      if (!username) return bad(res, 'Не указан логин');
      if (body.role && !access.ROLE_NAMES.includes(String(body.role).toUpperCase())) {
        return bad(res, `Неизвестная роль. Допустимые: ${access.ROLE_NAMES.join(', ')}`);
      }
      const role = access.normalizeRole(body.role || 'VIEWER');
      const r = await dbRun(`INSERT INTO admin_users (username, email, role) VALUES (?, ?, ?)`,
        [username, body.email || null, role]);
      const row = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [r.lastID]);
      console.log(`[Права] Заведён администратор ${username} с ролью ${role}`);
      // Ключ он заводит сам: POST /auth/register/options с ADMIN_INVITE_CODE
      // и своим логином — тогда passkey привяжется именно к этой строке.
      ok(res, { ...adminView(row), passkeys: 0 });
    } catch (e) {
      bad(res, /UNIQUE/.test(e.message) ? 'Такой логин или e-mail уже заведён' : e.message, 400);
    }
  });

  // Пригласить нового администратора. Домен `admins` — значит только владелец.
  app.post('/api/v1/admin/admins/invite', requireAdminJWT, async (req, res) => {
    try {
      const body = req.body || {};
      const role = String(body.role || 'VIEWER').toUpperCase();
      if (!access.ROLE_NAMES.includes(role)) {
        return bad(res, `Неизвестная роль. Допустимые: ${access.ROLE_NAMES.join(', ')}`);
      }
      const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 24 * 14);
      const username = body.username ? String(body.username).trim() : null;

      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

      let adminUserId = null;
      if (username) {
        const existing = await dbGet(`SELECT id FROM admin_users WHERE username = ?`, [username]).catch(() => null);
        if (existing) adminUserId = existing.id;
      }

      await dbRun(
        `INSERT INTO admin_invites (token, target_role, username, created_by, expires_at, admin_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [token, role, username, req.user?.username || 'SUPER_ADMIN', expiresAt, adminUserId]);

      const base = String(body.baseUrl || process.env.ADMIN_ORIGINS || '')
        .split(',').map(x => x.trim()).find(x => x.startsWith('http')) || '';
      console.log(`[Права] ${req.user?.username} выписал приглашение на роль ${role}`);
      ok(res, {
        token, role, username, expiresAt,
        link: base ? `${base.replace(/\/+$/, '')}/register?token=${token}` : `/register?token=${token}`
      });
    } catch (e) { bad(res, e.message, 500); }
  });

  const updateAdmin = async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [id]);
      if (!row) return bad(res, 'Администратор не найден', 404);

      const body = req.body || {};
      const patch = {};
      if (body.username !== undefined) patch.username = String(body.username).trim();
      if (body.email !== undefined) patch.email = body.email || null;

      if (body.role !== undefined) {
        if (!access.ROLE_NAMES.includes(String(body.role).toUpperCase())) {
          return bad(res, `Неизвестная роль. Допустимые: ${access.ROLE_NAMES.join(', ')}`);
        }
        const nextRole = access.normalizeRole(body.role);
        const wasSuper = access.normalizeRole(row.role) === 'SUPER_ADMIN';

        // Себя разжаловать нельзя: иначе достаточно одного неверного клика,
        // чтобы вылететь из раздела, где эту роль можно вернуть.
        if (wasSuper && nextRole !== 'SUPER_ADMIN' && String(req.user?.userId) === String(id)) {
          return bad(res, 'Нельзя снять роль владельца с самого себя', 409);
        }
        // И последнего владельца тоже: админка осталась бы без управления.
        if (wasSuper && nextRole !== 'SUPER_ADMIN' && (await superAdminCount(id)) === 0) {
          return bad(res, 'Это последний владелец — сначала назначьте другого', 409);
        }
        patch.role = nextRole;
      }

      const cols = Object.keys(patch);
      if (!cols.length) return bad(res, 'Нечего обновлять');
      await dbRun(`UPDATE admin_users SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...cols.map(c => patch[c]), id]);

      const next = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [id]);
      if (patch.role) console.log(`[Права] ${next.username}: роль -> ${patch.role}`);
      const keys = await passkeyCounts();
      ok(res, { ...adminView(next), passkeys: keys.get(id) || 0 });
    } catch (e) {
      bad(res, /UNIQUE/.test(e.message) ? 'Такой логин или e-mail уже заведён' : e.message, 400);
    }
  };
  app.put('/api/v1/admin/admins/:id', requireAdminJWT, updateAdmin);
  app.patch('/api/v1/admin/admins/:id', requireAdminJWT, updateAdmin);

  app.delete('/api/v1/admin/admins/:id', requireAdminJWT, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = await dbGet(`SELECT * FROM admin_users WHERE id = ?`, [id]);
      if (!row) return bad(res, 'Администратор не найден', 404);
      if (String(req.user?.userId) === String(id)) {
        return bad(res, 'Нельзя удалить самого себя', 409);
      }
      if (access.normalizeRole(row.role) === 'SUPER_ADMIN' && (await superAdminCount(id)) === 0) {
        return bad(res, 'Это последний владелец — сначала назначьте другого', 409);
      }
      // Ключи уходят вместе с админом, иначе по ним можно было бы войти
      // на удалённую учётную запись.
      await dbRun(`DELETE FROM admin_credentials WHERE admin_user_id = ?`, [id]).catch(() => {});
      await dbRun(`DELETE FROM admin_users WHERE id = ?`, [id]);
      console.log(`[Права] Удалён администратор ${row.username}`);
      res.json({ success: true, deleted: String(id) });
    } catch (e) { bad(res, e.message, 500); }
  });

  // ===========================================================================
  // ПОЛЬЗОВАТЕЛИ
  // ===========================================================================

  resource('/invites', 'invites', ['code', 'role', 'note', 'expires_at'], {
    search: ['code', 'note'], filters: { role: 'role' }
  });

  // Генерация кода — отдельная ручка, чтобы не придумывать код на фронте.
  app.post('/api/v1/admin/invites/generate', requireAdminJWT, async (req, res) => {
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    const r = await dbRun(`INSERT INTO invites (code, role, note) VALUES (?, ?, ?)`,
      [code, req.body?.role || 'admin', req.body?.note || '']);
    ok(res, await dbGet(`SELECT * FROM invites WHERE id = ?`, [r.lastID]));
  });

// ВАЖЕН ПОРЯДОК: /kyc/levels объявляется до /kyc/:id, иначе Express
  // сопоставит его как id="levels" и вернёт 404.
  resource('/kyc/levels', 'kyc_levels', ['level', 'title', 'withdraw_limit', 'requirements', 'enabled'], {
    order: 'level ASC'
  });

  resource('/kyc', 'kyc_requests', ['user_id', 'username', 'level', 'status', 'documents', 'comment'], {
    search: ['username', 'user_id'], filters: { status: 'status', level: 'level' },
    order: `CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC`
  });

  app.post('/api/v1/admin/kyc/:id/:decision(approve|reject)', requireAdminJWT, async (req, res) => {
    const status = req.params.decision === 'approve' ? 'approved' : 'rejected';
    await dbRun(`UPDATE kyc_requests SET status = ?, comment = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, req.body?.comment || '', req.params.id]);
    ok(res, await dbGet(`SELECT * FROM kyc_requests WHERE id = ?`, [req.params.id]));
  });

  resource('/guardian/banned-ips', 'guardian_ips', ['ip', 'reason', 'blocked_by', 'expires_at'], {
    search: ['ip', 'reason']
  });
  resource('/guardian/rules', 'guardian_rules', ['kind', 'pattern', 'action', 'note', 'active'], {
    search: ['pattern', 'note'], filters: { kind: 'kind' }
  });

  // Сводка «Гардиана»: сколько правил и блокировок сейчас действует.
  app.get('/api/v1/admin/guardian', requireAdminJWT, async (req, res) => {
    const ips = (await dbGet(`SELECT COUNT(*) AS c FROM guardian_ips`))?.c || 0;
    const rules = (await dbGet(`SELECT COUNT(*) AS c FROM guardian_rules WHERE active = 1`))?.c || 0;
    const banned = (await dbGet(`SELECT COUNT(*) AS c FROM users WHERE status = 'banned'`).catch(() => null))?.c || 0;
    ok(res, { blockedIps: ips, activeRules: rules, bannedUsers: banned, enabled: true });
  });

  app.get('/api/v1/admin/guardian/blocklist-coverage', requireAdminJWT, async (req, res) => {
    const ips = (await dbGet(`SELECT COUNT(*) AS c FROM guardian_ips`))?.c || 0;
    ok(res, { total: ips, sources: [{ name: 'Ручные блокировки', count: ips }], updatedAt: new Date().toISOString() });
  });

  // Пакетная блокировка IP одним запросом.
  app.post(['/api/v1/admin/guardian/bulk', '/api/v1/admin/guardian/bulk-block'], requireAdminJWT, async (req, res) => {
    const list = String(req.body?.ips || '').split(/[\s,;]+/).filter(Boolean);
    if (!list.length) return bad(res, 'Список IP пуст');
    let added = 0;
    for (const ip of list) {
      const r = await dbRun(`INSERT INTO guardian_ips (ip, reason, blocked_by) VALUES (?, ?, ?)`,
        [ip, req.body?.reason || 'Пакетная блокировка', req.user?.username || 'admin']).catch(() => null);
      if (r) added++;
    }
    ok(res, { added, requested: list.length });
  });

  app.post('/api/v1/admin/guardian/block', requireAdminJWT, async (req, res) => {
    const ip = String(req.body?.ip || '').trim();
    if (!ip) return bad(res, 'Не указан IP');
    const r = await dbRun(`INSERT INTO guardian_ips (ip, reason, blocked_by) VALUES (?, ?, ?)`,
      [ip, req.body?.reason || '', req.user?.username || 'admin']);
    ok(res, await dbGet(`SELECT * FROM guardian_ips WHERE id = ?`, [r.lastID]));
  });

  resource('/streamers', 'streamers', ['user_id', 'nickname', 'platform', 'url', 'promo_code', 'revenue_share', 'active'], {
    search: ['nickname', 'promo_code'], filters: { platform: 'platform' }
  });

  // Блокировка и разблокировка игрока.
  app.post('/api/v1/admin/users/:id/:action(block|unblock)', requireAdminJWT, async (req, res) => {
    const status = req.params.action === 'block' ? 'banned' : 'active';
    await dbRun(`UPDATE users SET status = ? WHERE id = ?`, [status, req.params.id]);
    ok(res, await dbGet(`SELECT * FROM users WHERE id = ?`, [req.params.id]));
  });

  // Ручная правка баланса и RTP игрока.
  app.put('/api/v1/admin/users/:id', requireAdminJWT, async (req, res) => {
    const fields = ['username', 'balance', 'rtp', 'role', 'status'].filter(f => req.body?.[f] !== undefined);
    if (!fields.length) return bad(res, 'Нечего обновлять');
    await dbRun(`UPDATE users SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...fields.map(f => req.body[f]), req.params.id]);
    ok(res, await dbGet(`SELECT * FROM users WHERE id = ?`, [req.params.id]));
  });

  // ===========================================================================
  // ФИНАНСЫ
  // ===========================================================================

  resource('/commission-rates', 'commission_rates', ['name', 'kind', 'percent', 'min_amount', 'max_amount', 'active'], {
    filters: { kind: 'kind' }, order: 'kind ASC, id ASC'
  });

  resource('/wallet-config/methods', 'wallet_methods', ['code', 'name', 'kind', 'icon', 'enabled', 'min_amount', 'max_amount', 'fee_percent', 'position'], {
    filters: { kind: 'kind' }, order: 'kind ASC, position ASC'
  });
  resource('/wallet-config/countries', 'wallet_countries', ['code', 'name', 'currency', 'enabled'], { order: 'name ASC' });
  resource('/wallet-config/rates', 'wallet_rates', ['currency', 'rate', 'source'], { order: 'currency ASC' });
  resource('/wallet-config/deposit-presets', 'deposit_presets', ['amount', 'bonus_percent', 'position', 'enabled'], { order: 'position ASC' });
  resource('/wallet/currency-rates', 'wallet_rates', ['currency', 'rate', 'source'], { order: 'currency ASC' });
  resource('/wallet/skin-deposits', 'skin_deposits', ['user_id', 'username', 'item_name', 'item_image', 'price', 'status'], {
    filters: { status: 'status' }, search: ['username', 'item_name']
  });

  app.post('/api/v1/admin/wallet/skin-deposits/:id/:decision(approve|reject)', requireAdminJWT, async (req, res) => {
    const status = req.params.decision === 'approve' ? 'approved' : 'rejected';
    await dbRun(`UPDATE skin_deposits SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, req.params.id]);
    ok(res, await dbGet(`SELECT * FROM skin_deposits WHERE id = ?`, [req.params.id]));
  });

  settings('/wallet-config', 'wallet_config');

  // Транзакции — таблица общая с игровым сервером.
  app.get('/api/v1/admin/transactions', requireAdminJWT, async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.type && req.query.type !== 'all') { where.push('t.type = ?'); params.push(req.query.type); }
    if (req.query.userId) { where.push('t.user_id = ?'); params.push(req.query.userId); }
    const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const total = (await dbGet(`SELECT COUNT(*) AS c FROM transactions t${sql}`, params).catch(() => null))?.c || 0;
    const rows = await dbAll(
      `SELECT t.*, u.username FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id${sql}
       ORDER BY t.id DESC LIMIT ?`, [...params, limit]).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total });
  });

  // Заявки на вывод + решения по ним.
  app.get(['/api/v1/admin/wallet/withdrawals', '/api/v1/admin/withdrawals'], requireAdminJWT, async (req, res) => {
    const where = req.query.status && req.query.status !== 'all' ? ' WHERE w.status = ?' : '';
    const params = where ? [req.query.status] : [];
    const rows = await dbAll(
      `SELECT w.*, u.username, u.steam_id FROM withdrawals w
       LEFT JOIN users u ON u.id = w.user_id${where}
       ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END, w.id DESC LIMIT 200`, params).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length });
  });

  app.post('/api/v1/admin/wallet/withdrawals/:id/:decision(approve|reject)', requireAdminJWT, async (req, res) => {
    const approve = req.params.decision === 'approve';
    const w = await dbGet(`SELECT * FROM withdrawals WHERE id = ?`, [req.params.id]);
    if (!w) return bad(res, 'Заявка не найдена', 404);
    if (w.status !== 'pending') return bad(res, 'Заявка уже обработана', 409);

    await dbRun(`UPDATE withdrawals SET status = ? WHERE id = ?`, [approve ? 'approved' : 'rejected', req.params.id]);
    if (!approve) {
      // Отклонили — деньги возвращаются игроку.
      await dbRun(`UPDATE users SET balance = balance + ? WHERE id = ?`, [w.amount, w.user_id]);
      await dbRun(`INSERT INTO transactions (user_id, type, amount, comment) VALUES (?, 'withdraw_refund', ?, ?)`,
        [w.user_id, w.amount, 'Возврат по отклонённой заявке']).catch(() => {});
    }
    ok(res, await dbGet(`SELECT * FROM withdrawals WHERE id = ?`, [req.params.id]));
  });

  app.get('/api/v1/admin/wallet/withdrawals/reaction-stats', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT status, COUNT(*) AS c FROM withdrawals GROUP BY status`).catch(() => []);
    const by = Object.fromEntries(rows.map(r => [r.status, r.c]));
    ok(res, { pending: by.pending || 0, approved: by.approved || 0, rejected: by.rejected || 0, avgReactionMinutes: 0 });
  });

  // Депозиты — берём из транзакций.
  // Пополнения. Раньше здесь показывались уже начисленные транзакции — то есть
  // только следствие. Теперь видны сами заявки, включая ждущие подтверждения:
  // без этого экрана подтверждать оплату было бы негде.
  app.get('/api/v1/admin/wallet/deposits', requireAdminJWT, async (req, res) => {
    const status = req.query.status;
    const where = status && status !== 'all' ? ` WHERE d.status = ?` : '';
    const rows = await dbAll(
      `SELECT d.*, u.username AS user_name, u.balance AS user_balance
         FROM deposits d LEFT JOIN users u ON u.id = d.user_id
         ${where} ORDER BY d.id DESC LIMIT 200`,
      status && status !== 'all' ? [status] : []).catch(() => []);

    const totals = await dbGet(
      `SELECT COUNT(*) AS pending, COALESCE(SUM(amount), 0) AS pendingSum
         FROM deposits WHERE status = 'pending'`).catch(() => ({ pending: 0, pendingSum: 0 }));

    res.json({
      success: true, data: rows, items: rows, total: rows.length,
      pending: totals?.pending || 0, pendingSum: totals?.pendingSum || 0
    });
  });

  /**
   * Подтверждение и отклонение заявки.
   *
   * Единственное место, где пополнение превращается в деньги на балансе.
   * Порядок операций: сначала переводим заявку из pending, и только если
   * строка действительно поменялась — трогаем баланс. При двойном клике или
   * двух администраторах разом второй UPDATE не найдёт pending и вернёт
   * changes = 0, так что дважды никто не начислит.
   */
  app.post('/api/v1/admin/wallet/deposits/:uid/:decision(approve|reject)', requireAdminJWT, async (req, res) => {
    try {
      const { uid, decision } = req.params;
      const row = await dbGet(`SELECT * FROM deposits WHERE uid = ?`, [uid]);
      if (!row) return bad(res, 'Заявка не найдена', 404);
      if (row.status !== 'pending') {
        return bad(res, `Заявка уже в статусе «${row.status}»`, 409);
      }

      if (decision === 'reject') {
        await dbRun(
          `UPDATE deposits SET status = 'rejected', settled_at = CURRENT_TIMESTAMP, settled_by = ?, comment = ?
            WHERE uid = ? AND status = 'pending'`,
          [req.user?.username || 'admin', req.body?.comment || 'Отклонено', uid]);
        console.log(`[Пополнение] ${req.user?.username} отклонил заявку ${uid}`);
        return ok(res, await dbGet(`SELECT * FROM deposits WHERE uid = ?`, [uid]));
      }

      // Сумму можно поправить: на крипте пришло не ровно столько, сколько ждали.
      const credited = Number(req.body?.amount != null ? req.body.amount : row.amount) || 0;
      if (credited <= 0) return bad(res, 'Некорректная сумма зачисления');

      const upd = await dbRun(
        `UPDATE deposits SET status = 'paid', credited = ?, settled_at = CURRENT_TIMESTAMP, settled_by = ?
          WHERE uid = ? AND status = 'pending'`,
        [credited, req.user?.username || 'admin', uid]);
      if (!upd.changes) return bad(res, 'Заявку уже обработали', 409);

      const u = await dbGet(`SELECT balance FROM users WHERE id = ?`, [row.user_id]);
      const next = Math.max(0, +((Number(u?.balance) || 0) + credited).toFixed(2));
      await dbRun(`UPDATE users SET balance = ? WHERE id = ?`, [next, row.user_id]);
      await dbRun(
        `INSERT INTO transactions (user_id, type, amount, comment) VALUES (?, 'deposit', ?, ?)`,
        [row.user_id, credited, `Пополнение ${row.method}${row.asset ? ' ' + row.asset : ''} №${uid}`]
      ).catch(() => {});

      console.log(`[Пополнение] ${req.user?.username} подтвердил ${uid}: +${credited} ₽ игроку ${row.user_id}`);
      ok(res, { ...(await dbGet(`SELECT * FROM deposits WHERE uid = ?`, [uid])), newBalance: next });
    } catch (e) { bad(res, e.message, 500); }
  });

  /** Сводка по деньгам — считается из реальных таблиц, а не выдумывается. */
  async function walletStats() {
    const sum = async (sql, p = []) => Number((await dbGet(sql, p).catch(() => null))?.s || 0);
    const deposits = await sum(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type='deposit'`);
    const withdrawals = await sum(`SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions WHERE type='withdraw'`);
    const wagered = await sum(`SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions WHERE type IN ('case_open','upgrade','battle_entry')`);
    const won = await sum(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN ('case_win','upgrade_win','battle_win','giveaway_win','deposit_chain')`);
    const balances = await sum(`SELECT COALESCE(SUM(balance),0) AS s FROM users`);
    const users = Number((await dbGet(`SELECT COUNT(*) AS c FROM users`).catch(() => null))?.c || 0);
    const pending = Number((await dbGet(`SELECT COUNT(*) AS c FROM withdrawals WHERE status='pending'`).catch(() => null))?.c || 0);
    return {
      deposits, withdrawals, wagered, won,
      ggr: +(wagered - won).toFixed(2),
      actualRtp: wagered > 0 ? +((won / wagered) * 100).toFixed(2) : 0,
      userBalances: balances, usersCount: users, pendingWithdrawals: pending,
      currency: 'RUB'
    };
  }

  app.get(['/api/v1/admin/wallet/stats', '/api/v1/admin/wallet'], requireAdminJWT, async (req, res) => ok(res, await walletStats()));
  app.get('/api/v1/admin/accounting', requireAdminJWT, async (req, res) => {
    const s = await walletStats();
    const byType = await dbAll(
      `SELECT type, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM transactions GROUP BY type ORDER BY ABS(SUM(amount)) DESC`).catch(() => []);
    ok(res, { ...s, byType });
  });

  app.get('/api/v1/admin/wallet/provider-balances', requireAdminJWT, async (req, res) => {
    const methods = await dbAll(`SELECT code, name, enabled FROM wallet_methods WHERE kind='deposit'`).catch(() => []);
    ok(res, methods.map(m => ({ provider: m.name, code: m.code, enabled: m.enabled === 1, balance: null, note: 'Платёжный провайдер не подключён' })));
  });

  app.get('/api/v1/admin/wallet/merchant-wallet-health', requireAdminJWT, async (req, res) => {
    const s = await walletStats();
    ok(res, { status: s.pendingWithdrawals > 20 ? 'warning' : 'ok', pendingWithdrawals: s.pendingWithdrawals, userBalances: s.userBalances, checkedAt: new Date().toISOString() });
  });

  // ===========================================================================
  // ИГРЫ И RTP
  // ===========================================================================

  // Игры и соцсети — списки, а не одна настройка: фронт правит их построчно
  // через PUT /config/games/:id. Идентификатор строковый ('cases'), поэтому
  // обычный resource() с числовым id здесь не подходит.
  textIdResource('/config/games', 'game_configs', ['name', 'enabled', 'min_bet', 'max_bet', 'house_edge']);
  textIdResource('/config/socials', 'social_links', ['name', 'url', 'enabled', 'position']);
  settings('/config/topdrops', 'topdrops');
  settings('/topdrops/config', 'topdrops');
  settings('/config/secret-cases', 'secret_cases');
  settings('/secret-cases/config', 'secret_cases');
  depositChainSettings();
  settings('/bots/config', 'bots_config');
  settings('/giveaways/streamer-configs', 'streamer_configs');

  resource('/rtp/tiers', 'rtp_tiers', ['name', 'rtp', 'min_deposit', 'max_deposit', 'priority', 'active'], {
    order: 'priority ASC'
  });

  // Назначение RTP игрокам.
  app.get('/api/v1/admin/rtp/users', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(
      `SELECT u.id, u.username, u.rtp, u.balance, a.tier_id, a.rtp_override, t.name AS tier_name
       FROM users u
       LEFT JOIN rtp_assignments a ON a.user_id = CAST(u.id AS TEXT)
       LEFT JOIN rtp_tiers t ON t.id = a.tier_id
       ORDER BY u.id DESC LIMIT 200`).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length });
  });

  app.post(['/api/v1/admin/rtp/users', '/api/v1/admin/rtp/users/bulk'], requireAdminJWT, async (req, res) => {
    const list = Array.isArray(req.body?.users) ? req.body.users
      : (req.body?.userId ? [{ userId: req.body.userId, tierId: req.body.tierId, rtp: req.body.rtp }] : []);
    if (!list.length) return bad(res, 'Не переданы пользователи');

    let applied = 0;
    for (const u of list) {
      const uid = String(u.userId ?? u.id);
      await dbRun(
        `INSERT INTO rtp_assignments (user_id, tier_id, rtp_override, assigned_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET tier_id = excluded.tier_id,
           rtp_override = excluded.rtp_override, assigned_at = CURRENT_TIMESTAMP`,
        [uid, u.tierId ?? null, u.rtp ?? null, req.user?.username || 'admin']).catch(() => {});

      // Итоговый RTP кладём в users.rtp — именно его читает розыгрыш кейсов.
      let rtp = u.rtp;
      if (rtp == null && u.tierId != null) {
        rtp = (await dbGet(`SELECT rtp FROM rtp_tiers WHERE id = ?`, [u.tierId]).catch(() => null))?.rtp;
      }
      if (rtp != null) { await dbRun(`UPDATE users SET rtp = ? WHERE id = ?`, [rtp, uid]); applied++; }
    }
    ok(res, { applied, requested: list.length });
  });

  /** Дашборд RTP: заявленная отдача против фактической. */
  app.get(['/api/v1/admin/rtp/dashboard', '/api/v1/admin/rtp/stats'], requireAdminJWT, async (req, res) => {
    const sum = async (sql) => Number((await dbGet(sql).catch(() => null))?.s || 0);
    const wagered = await sum(`SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions WHERE type IN ('case_open','upgrade','battle_entry')`);
    const won = await sum(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN ('case_win','upgrade_win','battle_win')`);
    const target = Number((await dbGet(`SELECT AVG(rtp) AS s FROM users`).catch(() => null))?.s || 95);
    const rounds = Number((await dbGet(`SELECT COUNT(*) AS c FROM transactions WHERE type='case_open'`).catch(() => null))?.c || 0);
    const tiers = await dbAll(`SELECT * FROM rtp_tiers ORDER BY priority ASC`).catch(() => []);

    ok(res, {
      targetRtp: +target.toFixed(2),
      actualRtp: wagered > 0 ? +((won / wagered) * 100).toFixed(2) : 0,
      deviation: wagered > 0 ? +(((won / wagered) * 100) - target).toFixed(2) : 0,
      wagered, won, rounds, tiers,
      ggr: +(wagered - won).toFixed(2)
    });
  });

  /** Валидация: расходятся ли настройки кейсов с заявленной отдачей. */
  app.get(['/api/v1/admin/rtp/validate', '/api/v1/admin/rtp/solve-preview'], requireAdminJWT, async (req, res) => {
    const cases = await dbAll(
      `SELECT c.id, c.slug, c.name, c.price,
              COUNT(ci.item_id) AS linked,
              SUM(CASE WHEN i.id IS NULL THEN 1 ELSE 0 END) AS broken,
              SUM(CASE WHEN i.id IS NOT NULL THEN 1 ELSE 0 END) AS usable,
              MIN(i.price) AS minPrice, MAX(i.price) AS maxPrice, AVG(i.price) AS avgPrice
       FROM cases c
       LEFT JOIN case_items ci ON ci.case_id = c.id
       LEFT JOIN items i ON i.id = ci.item_id
       WHERE c.archived = 0 GROUP BY c.id`).catch(() => []);

    const report = cases.map(c => {
      const problems = [];
      if (c.broken > 0) problems.push(`${c.broken} связей ведут на удалённые предметы`);
      if (c.usable < 2) problems.push(`доступно предметов: ${c.usable}`);
      if (c.usable > 0 && c.minPrice >= c.price) problems.push('самый дешёвый предмет дороже кейса — отдача выше 100%');
      return { ...c, ok: problems.length === 0, problems };
    });
    ok(res, { total: report.length, invalid: report.filter(r => !r.ok).length, cases: report });
  });

  // ===========================================================================
  // ТОП ДРОПОВ
  // ===========================================================================

    // Топ дропов по ВСЕМ источникам: инвентарь пополняется из кейсов, апгрейдера,
  // баттлов, розыгрышей и депозитной лестницы. Раньше считалось только по
  // battle_drops, поэтому одиночные открытия кейсов в топ не попадали.
  app.get('/api/v1/admin/topdrops', requireAdminJWT, async (req, res) => {
    const cfg = await readSetting('topdrops', { minPrice: 5000, limit: 20 });
    const rows = await dbAll(
      `SELECT inv.id, inv.name AS item_name, inv.image AS item_image, inv.price AS item_price,
              inv.rarity AS item_rarity, inv.source, inv.created_at, u.username
       FROM inventory inv LEFT JOIN users u ON u.id = inv.user_id
       WHERE inv.price >= ? ORDER BY inv.price DESC LIMIT ?`,
      [cfg.minPrice || 0, cfg.limit || 20]).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length, config: cfg });
  });
  app.post(['/api/v1/admin/topdrops/recalculate', '/api/v1/admin/topdrops/board/clear'], requireAdminJWT, async (req, res) => {
    ok(res, { status: 'done', recalculatedAt: new Date().toISOString() });
  });
  app.get('/api/v1/admin/topdrops/recalculate/status', requireAdminJWT, (req, res) =>
    ok(res, { running: false, lastRunAt: null }));
  app.post(['/api/v1/admin/topdrops/void', '/api/v1/admin/topdrops/best/remove'], requireAdminJWT, async (req, res) => {
    if (req.body?.dropId) await dbRun(`DELETE FROM battle_drops WHERE id = ?`, [req.body.dropId]).catch(() => {});
    ok(res, { removed: req.body?.dropId ?? null });
  });

  // ===========================================================================
  // СЕКРЕТНЫЕ КЕЙСЫ
  // ===========================================================================

  app.get('/api/v1/admin/secret-cases/queue', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(
      `SELECT c.id, c.slug, c.name, c.price, s.name AS series_name
       FROM cases c JOIN series s ON s.id = c.seriesId
       WHERE s.isSecret = 1 AND c.archived = 0 ORDER BY c.sortOrder ASC`).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length });
  });

  app.get(['/api/v1/admin/secret-cases/cycles', '/api/v1/admin/secret-cases/schedule'], requireAdminJWT, async (req, res) => {
    const cfg = await readSetting('secret_cases', {});
    const series = await dbAll(`SELECT id, name FROM series WHERE isSecret = 1`).catch(() => []);
    ok(res, { config: cfg, series, cycles: series.map((s, i) => ({ id: s.id, name: s.name, index: i, nextRevealAt: null })) });
  });

  app.post('/api/v1/admin/secret-cases/advance', requireAdminJWT, async (req, res) => {
    const cfg = await readSetting('secret_cases', { revealed: 0 });
    cfg.revealed = (cfg.revealed || 0) + 1;
    await writeSetting('secret_cases', cfg);
    ok(res, cfg);
  });

  // ===========================================================================
  // ДЕПОЗИТНАЯ ЛЕСТНИЦА
  // ===========================================================================

  app.get('/api/v1/admin/deposit-chain/cohorts', requireAdminJWT, async (req, res) => {
    const cfg = await readSetting('deposit_chain', { tiers: [] });
    const rows = await dbAll(
      `SELECT user_id, COALESCE(SUM(amount),0) AS deposited FROM transactions
       WHERE type='deposit' GROUP BY user_id`).catch(() => []);
    const tiers = cfg.tiers || [];
    const cohorts = tiers.map((t, i) => ({
      tierIndex: i, name: t.name, threshold: t.threshold,
      users: rows.filter(r => r.deposited >= t.threshold).length
    }));
    ok(res, { cohorts, totalUsers: rows.length });
  });

  // ===========================================================================
  // БОТЫ, ПРОМОКОДЫ, УВЕДОМЛЕНИЯ
  // ===========================================================================

  // ВАЖЕН ПОРЯДОК: /bots/profiles до /bots/:id, иначе Express примет
  // "profiles" за идентификатор и вернёт 404.
  resource('/bots/profiles', 'bot_profiles', ['name', 'avatar', 'behavior', 'min_bet', 'max_bet', 'join_delay_sec', 'active'], {
    search: ['name']
  });

  resource('/bots', 'bots', ['name', 'avatar', 'balance', 'strategy', 'min_bet', 'max_bet', 'active'], {
    search: ['name']
  });

  app.post('/api/v1/admin/bots/profiles/import', requireAdminJWT, async (req, res) => {
    const list = Array.isArray(req.body?.profiles) ? req.body.profiles : [];
    let added = 0;
    for (const p of list) {
      const r = await dbRun(`INSERT INTO bot_profiles (name, avatar, behavior, min_bet, max_bet) VALUES (?, ?, ?, ?, ?)`,
        [p.name, p.avatar || '', p.behavior || 'balanced', p.minBet || 50, p.maxBet || 5000]).catch(() => null);
      if (r) added++;
    }
    ok(res, { added, requested: list.length });
  });

  resource('/promo', 'promo_codes', ['code', 'kind', 'value', 'uses_limit', 'min_deposit', 'expires_at', 'active'], {
    search: ['code'], filters: { kind: 'kind', active: 'active' }
  });

  resource('/notifications', 'notifications', ['title', 'body', 'audience', 'status'], {
    search: ['title', 'body'], filters: { status: 'status' }
  });

  app.post('/api/v1/admin/notifications/send', requireAdminJWT, async (req, res) => {
    const id = req.body?.id;
    if (id) {
      await dbRun(`UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
      return ok(res, await dbGet(`SELECT * FROM notifications WHERE id = ?`, [id]));
    }
    const r = await dbRun(
      `INSERT INTO notifications (title, body, audience, status, sent_at) VALUES (?, ?, ?, 'sent', CURRENT_TIMESTAMP)`,
      [req.body?.title || '', req.body?.body || '', req.body?.audience || 'all']);
    ok(res, await dbGet(`SELECT * FROM notifications WHERE id = ?`, [r.lastID]));
  });

  // ===========================================================================
  // РОЗЫГРЫШИ И КАТАЛОГ
  // ===========================================================================

  app.get('/api/v1/admin/giveaways', requireAdminJWT, async (req, res) => {
    const where = req.query.status && req.query.status !== 'all' ? ' WHERE status = ?' : '';
    const rows = await dbAll(
      `SELECT g.*, (SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS participants
       FROM giveaways g${where} ORDER BY g.ends_at DESC LIMIT 100`,
      where ? [req.query.status] : []).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length });
  });

  app.get('/api/v1/admin/giveaways/mega', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(`SELECT * FROM giveaways WHERE kind='mega' ORDER BY ends_at DESC LIMIT 50`).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length });
  });

  app.get('/api/v1/admin/upgrader/items', requireAdminJWT, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const rows = await dbAll(
      `SELECT id, name, market_hash_name, price, rarity, color, image, upgraderEnabled
       FROM items WHERE upgraderEnabled = 1 AND delisted = 0 ORDER BY price DESC LIMIT ?`, [limit]).catch(() => []);
    const total = (await dbGet(`SELECT COUNT(*) AS c FROM items WHERE upgraderEnabled = 1 AND delisted = 0`).catch(() => null))?.c || 0;
    res.json({ success: true, data: rows, items: rows, total });
  });

  app.get('/api/v1/admin/cases/series/schedule', requireAdminJWT, async (req, res) => {
    const rows = await dbAll(
      `SELECT id, name, status, isLimited, isSecret, sortOrder FROM series ORDER BY sortOrder ASC`).catch(() => []);
    res.json({ success: true, data: rows, items: rows, total: rows.length });
  });

  console.log('[Admin] Разделы админки подключены');
}

module.exports = { makeAdminRoutes };
