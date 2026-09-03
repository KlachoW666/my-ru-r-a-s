'use strict';
const { bannerContent } = require('../../services/bannerContent');

function register({ app, dbAll, dbGet, dbRun, requireAdminJWT }) {
  let schemaReady;
  function ensureSchema() {
    if (!schemaReady) schemaReady = (async () => {
      const columns = await dbAll('PRAGMA table_info(banners)');
      if (!columns.some(column => column.name === 'content')) {
        await dbRun('ALTER TABLE banners ADD COLUMN content TEXT');
      }
    })().catch(error => { schemaReady = undefined; throw error; });
    return schemaReady;
  }
  const dto = row => ({ id: row.id, content: bannerContent(row), sort_order: row.position });
  const fail = (res, status, message) => res.status(status).json({ success: false, message });
  const handle = fn => async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (error) { console.error('[Banners]', error); fail(res, 500, 'Не удалось сохранить или загрузить баннеры'); }
  };
  const textFields = ['title', 'description', 'image', 'mobileImage', 'video', 'mobileVideo',
    'background', 'buttonText', 'buttonColor', 'glowColor', 'borderColor', 'buttonAction', 'buttonValue'];
  function validate(body) {
    const c = body?.content;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'Нужно передать content';
    if (typeof c.title !== 'string' || !c.title.trim()) return 'Нужно название';
    if (typeof c.isActive !== 'boolean') return 'isActive должен быть boolean';
    if (textFields.some(key => c[key] !== undefined && typeof c[key] !== 'string')) return 'Поля контента должны быть строками';
    if (body.sort_order !== undefined && (!Number.isSafeInteger(body.sort_order) || body.sort_order < 0)) return 'Некорректный порядок';
    if (c.buttonAction && !['url', 'promo'].includes(c.buttonAction)) return 'Некорректное действие кнопки';
    if (c.buttonAction && !c.buttonValue?.trim()) return 'Нужно значение кнопки';
    if (c.buttonAction === 'url' && !/^(\/(?!\/)|https?:\/\/)/i.test(c.buttonValue)) return 'Нужен путь сайта или HTTP(S) URL';
    if (c.borderColor && !/^#[0-9a-f]{6}$/i.test(c.borderColor)) return 'Некорректный цвет рамки';
    return null;
  }
  function cleanContent(c) {
    const result = { isActive: c.isActive };
    for (const key of textFields) if (c[key] !== undefined) result[key] = c[key];
    result.title = result.title.trim();
    return result;
  }
  const prefix = '/api/v1/admin/banners';
  app.get(prefix, requireAdminJWT, handle(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const total = (await dbGet('SELECT COUNT(*) AS total FROM banners')).total;
    const rows = await dbAll('SELECT * FROM banners ORDER BY position, id LIMIT ? OFFSET ?', [limit, (page - 1) * limit]);
    res.json({ success: true, data: rows.map(dto), total, pagination: { page, limit, total } });
  }));
  app.post(prefix, requireAdminJWT, handle(async (req, res) => {
    const error = validate(req.body);
    if (error) return fail(res, 400, error);
    const c = cleanContent(req.body.content);
    const result = await dbRun('INSERT INTO banners (title, image, url, position, active, content) VALUES (?, ?, ?, ?, ?, ?)',
      [c.title, c.image || '', c.buttonAction === 'url' ? c.buttonValue : '', req.body.sort_order ?? 0, Number(c.isActive), JSON.stringify(c)]);
    res.json({ success: true, data: dto(await dbGet('SELECT * FROM banners WHERE id = ?', [result.lastID])) });
  }));
  app.put(`${prefix}/:id`, requireAdminJWT, handle(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return fail(res, 404, 'Баннер не найден');
    const row = await dbGet('SELECT * FROM banners WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'Баннер не найден');
    const error = validate(req.body);
    if (error) return fail(res, 400, error);
    // The form sends a complete content object: omitted optional fields mean removal.
    const c = cleanContent(req.body.content);
    const result = await dbRun('UPDATE banners SET title = ?, image = ?, url = ?, position = COALESCE(?, position), active = ?, content = ? WHERE id = ?',
      [c.title, c.image || '', c.buttonAction === 'url' ? c.buttonValue : '', req.body.sort_order ?? null, Number(c.isActive), JSON.stringify(c), req.params.id]);
    if (!result.changes) return fail(res, 404, 'Баннер не найден');
    res.json({ success: true, data: dto(await dbGet('SELECT * FROM banners WHERE id = ?', [req.params.id])) });
  }));
}

module.exports = { register };
