'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
const { makeAchievementsService, CATALOG } = require('../services/achievements');

/* test_strategy:
 * artifact: achievements — progress, unlocking and the bonus behind it
 * rationale: Every unlock credits money or a spin. Granting one twice is a money bug.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Unlock and reward must commit together in real SQLite.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [temporary SQLite]
 *     gate: Gate 2
 * rejected_types:
 *   - reason: The toast is presentation; the money decision is on the server.
 *     type: component
 *   - reason: No production account should be credited for verification.
 *     type: e2e
 */

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bearz-ach-'));
  const file = path.join(dir, 'db.sqlite');
  const getAdminDb = () => new sqlite.Database(file);
  const run = (sql, p = []) => new Promise((res, rej) => {
    const db = getAdminDb(); db.run(sql, p, function (e) { db.close(() => e ? rej(e) : res(this)); });
  });
  const all = (sql, p = []) => new Promise((res, rej) => {
    const db = getAdminDb(); db.all(sql, p, (e, r) => db.close(() => e ? rej(e) : res(r || [])));
  });
  const queryAdminDb = async (sql, p = []) => {
    try { return await all(sql, p); } catch { const x = []; x.failed = true; return x; }
  };
  await run('CREATE TABLE users(id INTEGER PRIMARY KEY, balance REAL NOT NULL)');
  await run('INSERT INTO users VALUES(1, 0)');
  await run(`CREATE TABLE transactions(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT,
    amount REAL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { service: makeAchievementsService({ getAdminDb, queryAdminDb }), run, all };
}

test('AC1 каталог непротиворечив: коды уникальны, у каждого есть награда', () => {
  const codes = CATALOG.map(a => a.code);
  assert.equal(new Set(codes).size, codes.length, 'коды достижений должны быть уникальны');
  for (const a of CATALOG) {
    assert.ok(a.threshold > 0, `${a.code}: порог должен быть больше нуля`);
    assert.ok(['balance', 'spin', 'discount'].includes(a.reward.kind), `${a.code}: неизвестный тип награды`);
    if (a.reward.kind === 'discount') assert.ok(a.reward.maxCasePrice > 0, `${a.code}: у скидки нужен порог цены`);
  }
});

test('AC2 при нулевом прогрессе ничего не выдаётся и баланс не трогается', async t => {
  const { service, all } = await fixture(t);
  const { unlocked } = await service.evaluate(1);
  assert.equal(unlocked.length, 0);
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 0);
  assert.equal((await all('SELECT code FROM user_achievements')).length, 0);
});

test('AC3 открытие кейса открывает достижение, но НЕ начисляет само', async t => {
  const { service, run, all } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-100,'Открытие: Кейс x1')");
  const { unlocked } = await service.evaluate(1);
  assert.ok(unlocked.map(u => u.code).includes('case_1'), 'должно открыться «Первый кейс»');
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 0,
    'до нажатия «Получить» баланс не трогается');

  const claimed = await service.claim(1, 'case_1');
  assert.equal(claimed.reward.value, 10);
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 10);
  const tx = await all("SELECT type,amount FROM transactions WHERE type='achievement'");
  assert.deepEqual(tx.map(x => x.amount), [10]);
});

test('AC3b награду нельзя забрать дважды', async t => {
  const { service, run, all } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-100,'Открытие: Кейс x1')");
  await service.evaluate(1);
  await service.claim(1, 'case_1');
  await assert.rejects(() => service.claim(1, 'case_1'), e => e.code === 'ALREADY_CLAIMED');
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 10, 'бонус остался один');
});

test('AC3c неоткрытое достижение забрать нельзя', async t => {
  const { service, all } = await fixture(t);
  await assert.rejects(() => service.claim(1, 'case_1'), e => e.code === 'NOT_UNLOCKED');
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 0);
});

test('AC3d закрытое уведомление не теряет награду — она ждёт в профиле', async t => {
  const { service, run } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-100,'Открытие: Кейс x1')");
  await service.evaluate(1);
  await service.pending(1);                       // уведомление показано и закрыто
  const { items, claimable } = await service.list(1);
  assert.ok(claimable >= 1, 'награда осталась доступной');
  assert.equal(items.find(i => i.code === 'case_1').claimable, true);
});

test('AC4 повторный пересчёт не открывает достижение заново', async t => {
  const { service, run, all } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-100,'Открытие: Кейс x1')");
  await service.evaluate(1);
  await service.claim(1, 'case_1');
  const after = (await all('SELECT balance FROM users WHERE id=1'))[0].balance;
  await service.evaluate(1);
  await service.evaluate(1);
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, after,
    'три пересчёта — один бонус');
  assert.equal((await all('SELECT code FROM user_achievements')).length,
    (await all('SELECT DISTINCT code FROM user_achievements')).length);
});

test('AC5 xN в комментарии считается как N открытий', async t => {
  const { service, run } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-500,'Открытие: Кейс x5')");
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-500,'Открытие: Кейс x5')");
  const m = await service.metrics(1);
  assert.equal(m.casesOpened, 10, 'два открытия по пять — это десять кейсов');
  const { unlocked } = await service.evaluate(1);
  assert.ok(unlocked.map(u => u.code).includes('case_10'));
});

test('AC6 награда-прокрут кладётся в журнал попыток колеса', async t => {
  const { service, run, all } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'deposit',500,'test')");
  const { unlocked } = await service.evaluate(1);
  assert.ok(unlocked.map(u => u.code).includes('dep_first'));
  await service.claim(1, 'dep_first');
  const spins = await all("SELECT kind FROM wheel_spins WHERE kind='achievement'");
  assert.equal(spins.length, 1);
});

test('AC7 награда-скидка создаёт скидку с порогом и сроком', async t => {
  const { service, run, all } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'deposit',10000,'test')");
  await service.evaluate(1);
  await service.claim(1, 'dep_10k');
  const rows = await all("SELECT percent,max_case_price,expires_at FROM case_discounts WHERE source='achievement'");
  assert.ok(rows.length >= 1, 'дошли до «Десятка» — должна быть скидка');
  assert.equal(rows[0].percent, 35);
  assert.equal(rows[0].max_case_price, 599);
  assert.ok(rows[0].expires_at);
});

test('AC8 уведомление отдаётся один раз', async t => {
  const { service, run } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-100,'Открытие: Кейс x1')");
  await service.evaluate(1);
  const first = await service.pending(1);
  assert.ok(first.length >= 1, 'первое обращение показывает достижение');
  assert.ok(first[0].rewardText, 'в уведомлении должен быть текст награды');
  assert.deepEqual(await service.pending(1), [], 'второе обращение уже пустое');
});

test('AC9 список показывает прогресс до порога, а не только факт', async t => {
  const { service, run } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-100,'Открытие: Кейс x1')");
  }
  const { items } = await service.list(1);
  const ten = items.find(i => i.code === 'case_10');
  assert.equal(ten.progress, 3);
  assert.equal(ten.threshold, 10);
  assert.equal(ten.percent, 30);
  assert.equal(ten.unlocked, false);
});

test('AC10 гостю список отдаётся без прогресса и без выдачи', async t => {
  const { service, all } = await fixture(t);
  const { items, unlocked } = await service.list(null);
  assert.equal(items.length, CATALOG.length);
  assert.equal(unlocked, 0);
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 0);
});

test('AC11 отсутствие inventory не роняет пересчёт', async t => {
  // Таблицы inventory в этой базе нет — метрики по дропам должны дать 0.
  const { service, run } = await fixture(t);
  await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'case_open',-100,'Открытие: Кейс x1')");
  const m = await service.metrics(1);
  assert.equal(m.bestDrop, 0);
  assert.equal(m.itemsWon, 0);
  const { unlocked } = await service.evaluate(1);
  assert.ok(unlocked.length >= 1);
});
