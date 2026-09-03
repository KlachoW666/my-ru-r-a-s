'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const express = require('../admin.titanrust.ru/server/node_modules/express');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');

test('banner form saves content, edits and deactivates the shared SQLite row', async () => {
  const db = new sqlite.Database(':memory:');
  const dbRun = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (err) {
    err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
  }));
  const dbAll = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (err, rows) => err ? reject(err) : resolve(rows)));
  const dbGet = async (sql, args) => (await dbAll(sql, args))[0];
  let server;
  try {
    await dbRun('CREATE TABLE banners (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, image TEXT, url TEXT, position INTEGER DEFAULT 0, active INTEGER DEFAULT 1)');
    await dbRun('INSERT INTO banners (title, image, url, position, active) VALUES (?, ?, ?, ?, ?)',
      ['Legacy banner', '/legacy.webp', '/cases', 99, 0]);
    const app = express();
    app.use(express.json());
    // Real registration order, without starting production services or loading .env.
    const filename = path.resolve(__dirname, '../admin.titanrust.ru/server/server.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf("require('./bannerRoutes').register");
    const end = source.indexOf("app.get('/api/v1/admin/pages',", start);
    assert.ok(start >= 0 && end > start, 'route registration anchors exist');
    vm.runInNewContext(source.slice(start, end), { app, dbAll, dbGet, dbRun,
      requireAdminJWT: (req, res, next) => next(), require: createRequire(filename), console });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const request = async (method, suffix = '', body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/banners${suffix}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    const legacy = (await request('GET')).body.data[0];
    assert.deepEqual(legacy.content, { title: 'Legacy banner', image: '/legacy.webp', buttonAction: 'url', buttonValue: '/cases', isActive: false });
    const content = { title: 'Test banner', description: 'Saved description', image: '/test.webp',
      mobileImage: '/mobile.webp', buttonText: 'Open', buttonAction: 'url', buttonValue: '/cases', isActive: true };
    const created = await request('POST', '', { content, sort_order: 7 });
    assert.equal(created.status, 200);
    const id = created.body.data.id;
    assert.equal((await dbGet('SELECT title FROM banners WHERE id = ?', [id])).title, content.title);
    let listed = await request('GET');
    assert.deepEqual(listed.body.data[0].content, content);
    assert.equal(listed.body.data[0].sort_order, 7);
    const siteFilename = path.resolve(__dirname, '../server.js');
    const siteSource = fs.readFileSync(siteFilename, 'utf8');
    const siteStart = siteSource.indexOf('async function getLiveBanners()');
    const siteEnd = siteSource.indexOf('// --- MOCK USER & CONFIG ---', siteStart);
    assert.ok(siteStart >= 0 && siteEnd > siteStart);
    const liveBanners = vm.runInNewContext(siteSource.slice(siteStart, siteEnd) + '\ngetLiveBanners;', {
      queryAdminDb: dbAll, require: createRequire(siteFilename)
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await liveBanners())), [{ ...content, id: `banner-${id}` }]);
    const updated = { title: 'Changed', isActive: false };
    assert.equal((await request('PUT', `/${id}`, { content: updated })).status, 200);
    const row = await dbGet('SELECT * FROM banners WHERE id = ?', [id]);
    assert.equal(row.active, 0);
    assert.equal(row.position, 7, 'deactivation preserves sorting');
    assert.equal(row.image, '', 'removing optional content clears the legacy field');
    assert.equal((await liveBanners()).length, 0, 'deactivating all banners must not resurrect demo banners');
    listed = await request('GET');
    assert.deepEqual(listed.body.data[0].content, updated);
    assert.equal((await request('PUT', '/999999', { content })).status, 404);
    assert.equal((await request('POST', '', { content: { title: '', isActive: true } })).status, 400);
    assert.equal((await request('POST', '', { content, sort_order: -1 })).status, 400);
    assert.equal((await request('POST', '', { content: { ...content, buttonValue: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await request('POST', '', { content: { ...content, isActive: 'false' } })).status, 400);
    assert.equal((await dbGet('SELECT COUNT(*) AS n FROM banners')).n, 2, 'invalid requests must not create rows');
    const secondPage = await request('GET', '?page=2&limit=1');
    assert.equal(secondPage.body.total, 2);
    assert.equal(secondPage.body.data.length, 1);
    assert.equal(secondPage.body.data[0].id, legacy.id);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  }
});
