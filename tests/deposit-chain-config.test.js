'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('../admin.titanrust.ru/server/node_modules/express');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
const { makeAdminRoutes } = require('../admin.titanrust.ru/server/adminRoutes');

/*
test_strategy:
  artifact: deposit-chain configuration and case resolution
  rationale: The player widget crosses admin configuration, SQLite, HTTP and money-awarding game logic; a missing case reference currently produces a clickable card that cannot navigate.
  criticality: HIGH
  selected_types:
    - rationale: Legacy configuration normalization and explicit case resolution contain branches that must fail closed.
      type: unit
      size: small
      framework: node:test
      dependencies: [Node vm with the real server function]
      gate: Gate 1
    - rationale: Admin save validation and persistence cross real Express and SQLite boundaries.
      type: integration
      size: medium
      framework: node:test
      dependencies: [Express, SQLite in a temporary directory]
      gate: Gate 2
  rejected_types:
    - reason: The compiled Vue source is unavailable and backend integration covers the critical decision path.
      type: component
    - reason: Admin and site clients deploy from the same repository, so a separate consumer contract suite adds little value.
      type: contract
    - reason: The domain is five fixed tiers and three configured groups, not an unbounded input space.
      type: property-based
  deliberately_skipped:
    - why: No production deployment or authenticated Steam session is available in this test run.
      what: Browser E2E and post-deploy smoke tests.
Test Cases to Cover:
- [integration] AC1 GET upgrades the legacy five-tier value to the matrix contract without changing SQLite.
- [integration] AC2 PUT rejects a case that is not active and exclusive to DEPOSIT_CHAIN.
- [integration] AC3 PUT persists five positive thresholds and fifteen B/C/D case references.
- [unit] AC4 Case resolution accepts caseRef and never falls back to an unrelated ordinary case.
- [unit] AC5 The selected B/C/D matrix row is merged into the five player tiers.
- [integration] AC6 A free first tier is valid, while thresholds must remain strictly increasing.
- [unit] AC7 The compiled save action accepts a zero threshold for tier 0.
- [unit] AC8 A rejected confirmation closes before showing the validation error.
*/

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satchel-deposit-chain-'));
  const db = new sqlite.Database(path.join(dir, 'test.sqlite'));
  const dbRun = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (error) {
    error ? reject(error) : resolve({ lastID: this.lastID, changes: this.changes });
  }));
  const dbAll = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
  const dbGet = async (sql, args = []) => (await dbAll(sql, args))[0];

  await dbRun('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');
  await dbRun(`CREATE TABLE cases(
    id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,image TEXT,price REAL,
    exclusiveTo TEXT,status TEXT,isActive INTEGER,archived INTEGER)`);
  await dbRun('CREATE TABLE case_items(case_id INTEGER,item_id INTEGER)');
  await dbRun('CREATE TABLE items(id INTEGER PRIMARY KEY,delisted INTEGER DEFAULT 0,admin_disabled INTEGER DEFAULT 0)');
  await dbRun('CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,created_at TEXT)');
  await dbRun('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT)');
  await dbRun(`INSERT INTO app_settings(key,value,updated_at) VALUES('deposit_chain',?,CURRENT_TIMESTAMP)`, [JSON.stringify({
    enabled: true,
    variant: 'B',
    tiers: [
      { name: 'Камень', threshold: 0 }, { name: 'Лук', threshold: 174 },
      { name: 'Двушка', threshold: 384 }, { name: 'Томпсон', threshold: 821 },
      { name: 'Калаш', threshold: 1166 }
    ]
  })]);
  await dbRun("INSERT INTO cases VALUES(1,'deposit-case','Deposit case','/deposit.webp',100,'DEPOSIT_CHAIN','active',1,0)");
  await dbRun("INSERT INTO cases VALUES(2,'ordinary-case','Ordinary case','/ordinary.webp',100,'','active',1,0)");
  await dbRun('INSERT INTO items(id) VALUES(1),(2)');
  await dbRun('INSERT INTO case_items(case_id,item_id) VALUES(1,1),(1,2),(2,1),(2,2)');

  const app = express();
  app.use(express.json());
  makeAdminRoutes({ app, dbAll, dbGet, dbRun, requireAdminJWT: (req, _res, next) => {
    req.user = { username: 'owner', role: 'SUPER_ADMIN' };
    next();
  }});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, dbGet };
}

function validBody(caseRef = 'deposit-case') {
  return {
    tiers: [100, 200, 300, 400, 500].map((threshold, tierIndex) => ({ tierIndex, threshold })),
    caseRefs: ['B', 'C', 'D'].flatMap(group => [0, 1, 2, 3, 4].map(tierIndex => ({ group, tierIndex, caseRef })))
  };
}

test('AC1 GET normalizes a legacy ladder for the matrix editor', async t => {
  const { request } = await fixture(t);
  const response = await request('GET', '/config/deposit-chain');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.tiers.map(tier => tier.tierIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(response.body.data.caseRefs, []);
});

test('AC2 PUT rejects an ordinary case', async t => {
  const { request } = await fixture(t);
  const response = await request('PUT', '/config/deposit-chain', validBody('ordinary-case'));
  assert.equal(response.status, 409);
  assert.match(response.body.message, /DEPOSIT_CHAIN.*ordinary-case/);
});

test('AC3 PUT persists the complete ladder matrix', async t => {
  const { request, dbGet } = await fixture(t);
  const response = await request('PUT', '/config/deposit-chain', validBody());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.tiers.length, 5);
  assert.equal(response.body.data.caseRefs.length, 15);
  const saved = JSON.parse((await dbGet("SELECT value FROM app_settings WHERE key='deposit_chain'")).value);
  assert.equal(saved.caseRefs[14].caseRef, 'deposit-case');
});

test('AC4 tier case resolution reads an explicit caseRef', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function tierLinkedCase(');
  const end = source.indexOf('/**\n * Кейс тира для показа', start);
  const tierLinkedCase = vm.runInNewContext(`${source.slice(start, end)}\ntierLinkedCase;`);
  const cases = [{ id: 1, slug: 'ordinary' }, { id: 2, slug: 'deposit-case' }];
  assert.equal(tierLinkedCase({ caseRef: 'deposit-case' }, cases).slug, 'deposit-case');
  assert.equal(tierLinkedCase({}, cases), null);
});

test('AC5 selected matrix group is merged into player tiers', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function depositTiersForVariant(');
  const end = source.indexOf('\nasync function depositTiersConfig', start);
  assert.ok(start >= 0 && end > start, 'depositTiersForVariant helper must exist');
  const helper = vm.runInNewContext(`${source.slice(start, end)}\ndepositTiersForVariant;`);
  const config = {
    tiers: [0, 1, 2, 3, 4].map(tierIndex => ({ tierIndex, threshold: (tierIndex + 1) * 100 })),
    caseRefs: [0, 1, 2, 3, 4].map(tierIndex => ({ group: 'C', tierIndex, caseRef: `case-c-${tierIndex}` }))
  };
  const result = JSON.parse(JSON.stringify(helper(config, 'C')));
  assert.deepEqual(result.map(tier => tier.caseRef), ['case-c-0', 'case-c-1', 'case-c-2', 'case-c-3', 'case-c-4']);
  assert.deepEqual(result.map(tier => tier.threshold), [100, 200, 300, 400, 500]);
});

test('AC6 first threshold may be zero but thresholds must increase', async t => {
  const { request } = await fixture(t);
  const freeFirst = validBody();
  freeFirst.tiers = [0, 174, 384, 821, 1166].map((threshold, tierIndex) => ({ tierIndex, threshold }));
  assert.equal((await request('PUT', '/config/deposit-chain', freeFirst)).status, 200);
  const reversed = validBody();
  reversed.tiers = [0, 174, 174, 821, 1166].map((threshold, tierIndex) => ({ tierIndex, threshold }));
  const response = await request('PUT', '/config/deposit-chain', reversed);
  assert.equal(response.status, 400);
  assert.match(response.body.message, /возрастать/);
});

function compiledDepositChainSave(overrides = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../admin.titanrust.ru/public/assets/DepositChainConfigPage-Bn4BxJsx.js'), 'utf8');
  const start = source.indexOf('async function ae(){');
  const end = source.indexOf('return(s,e)=>', start);
  assert.ok(start >= 0 && end > start, 'compiled deposit-chain save action must exist');
  const calls = [];
  const errors = [];
  const groups = ['B', 'C', 'D'];
  const tiers = [0, 1, 2, 3, 4];
  const refs = Object.fromEntries(groups.flatMap(group => tiers.map(tier => [`${group}:${tier}`, 'deposit-case'])));
  const context = {
    h: tiers,
    p: { value: { 0: '0', 1: '174', 2: '384', 3: '821', 4: '1166' } },
    T: groups,
    r: { value: refs },
    g: (group, tier) => `${group}:${tier}`,
    A: { value: false },
    G: { value: true },
    v: { error: message => errors.push(String(message)), success() {} },
    Se: { mutateAsync: async payload => { calls.push(payload); return { data: payload.data }; } },
    E: { value: new Set() },
    B: { setQueryData() {} },
    Je: () => ['deposit-chain'],
    ...overrides
  };
  return { save: vm.runInNewContext(`${source.slice(start, end)}\nae;`, context), context, calls, errors };
}

test('AC7 compiled save accepts a free first tier', async () => {
  const subject = compiledDepositChainSave();
  await subject.save();
  assert.equal(subject.errors.length, 0);
  assert.equal(subject.calls.length, 1);
  assert.equal(subject.calls[0].data.tiers[0].threshold, '0');
});

test('AC8 invalid confirmation closes before reporting its error', async () => {
  const subject = compiledDepositChainSave({ r: { value: {} } });
  await subject.save();
  assert.equal(subject.context.G.value, false);
  assert.match(subject.errors[0], /Не выбран кейс для группы B, тир 0/);
});
