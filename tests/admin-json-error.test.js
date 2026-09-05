'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('../admin.titanrust.ru/server/node_modules/express');
const { jsonErrorHandler } = require('../admin.titanrust.ru/server/jsonError');

test('malformed admin JSON returns a readable JSON error envelope', async t => {
  const messages = [];
  const app = express();
  app.use(express.json());
  app.use(jsonErrorHandler({ logger: { warn: message => messages.push(message) } }));
  app.post('/api/v1/admin/cases', (_req, res) => res.json({ success: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://admin.titanrust.ru' },
    body: 't'
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_JSON');
  assert.equal(body.error.message, body.message);
  assert.match(messages[0], /POST \/api\/v1\/admin\/cases/);
  assert.doesNotMatch(messages[0], /body=t/);
});
