'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('../admin.titanrust.ru/server/node_modules/express');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
const { register } = require('../admin.titanrust.ru/server/adminKeys');

test('admin key schema initializes on an empty SQLite database', async () => {
  const db = new sqlite.Database(':memory:');
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
  try {
    register({ app: express(), db, dbRun: run, dbGet: get,
      dbAll: () => Promise.resolve([]), generateAdminJWT: () => '',
      requireAdminJWT: (req, res, next) => next(), access: {} });
    const deadline = Date.now() + 3000;
    let ready;
    do {
      ready = await get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_admin_keys_hash'");
      if (ready) break;
      await new Promise(resolve => setImmediate(resolve));
    } while (Date.now() < deadline);
    assert.ok(ready, 'key index must be created after its table');
    await run('INSERT INTO admin_access_keys (key_hash) VALUES (?)', ['fixture-hash']);
    assert.equal((await get('SELECT COUNT(*) AS n FROM admin_access_keys')).n, 1);
  } finally {
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  }
});
