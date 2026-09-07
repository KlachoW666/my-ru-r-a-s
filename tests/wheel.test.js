'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('../admin.titanrust.ru/server/node_modules/sqlite3');
const { makeWheelService, sectorRing, DEFAULT_SECTORS } = require('../services/wheel');
const { makeInventoryService } = require('../services/inventory');

/* test_strategy:
 * artifact: bonus wheel — spin ledger, prizes and case discounts
 * rationale: Spins and discounts are money. A double click must not burn two spins,
 *            and a won discount must not be spendable twice.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Grant/consume and discount redemption are real SQLite transactions.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [temporary SQLite]
 *     gate: Gate 2
 *   - rationale: Sector weights are pure arithmetic and cheap to pin exactly.
 *     type: unit
 *     size: small
 *     framework: node:test
 *     gate: Gate 1
 * rejected_types:
 *   - reason: The wheel animation carries no money decision; Gate 3 covers rendering elsewhere.
 *     type: component
 *   - reason: No production account should be spun for verification.
 *     type: e2e
 * deliberately_skipped:
 *   - what: Real concurrent spin from two browsers
 *     why: Serialised here through the same conditional UPDATE the server uses.
 */

// Броски задаются списком — колесо должно попадать в заданный сектор, а не
// «примерно туда». Иначе проверить выдачу приза нельзя.
function fakeFairness(rolls) {
  let i = 0;
  return {
    async nextRoll() {
      const roll = rolls[Math.min(i, rolls.length - 1)]; i++;
      return { rolls: [{ nonce: i, roll }], serverHash: 'hash', clientSeed: 'client', seedId: 1, startNonce: i };
    }
  };
}

async function fixture(t, { rolls = [0], deposits = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bearz-wheel-'));
  const file = path.join(dir, 'db.sqlite');
  const getAdminDb = () => new sqlite.Database(file);
  const run = (sql, p = []) => new Promise((res, rej) => {
    const db = getAdminDb(); db.run(sql, p, function (e) { db.close(() => e ? rej(e) : res(this)); });
  });
  const all = (sql, p = []) => new Promise((res, rej) => {
    const db = getAdminDb(); db.all(sql, p, (e, r) => db.close(() => e ? rej(e) : res(r || [])));
  });
  const queryAdminDb = async (sql, p = []) => { try { return await all(sql, p); } catch { const x = []; x.failed = true; return x; } };

  await run('CREATE TABLE users(id INTEGER PRIMARY KEY, balance REAL NOT NULL)');
  await run('INSERT INTO users VALUES(1, 1000)');
  await run(`CREATE TABLE transactions(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT,
    amount REAL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  for (const amount of deposits) {
    await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(1,'deposit',?,'test')", [amount]);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wheel = makeWheelService({ getAdminDb, queryAdminDb, fairness: fakeFairness(rolls) });
  return { wheel, run, all, queryAdminDb, getAdminDb };
}

// --- Раскладка ---------------------------------------------------------------

test('AC1 колесо ровно из 24 секторов, веса дают 100%', () => {
  const ring = sectorRing();
  assert.equal(ring.length, 24);
  assert.equal(DEFAULT_SECTORS.reduce((s, d) => s + d.weight * d.copies, 0), 10000);
});

// --- Начисление попыток ------------------------------------------------------

test('AC2 бесплатная попытка выдаётся раз в сутки и не дублируется', async t => {
  const { wheel, all } = await fixture(t);
  await wheel.state(1);
  await wheel.state(1);
  await wheel.state(1);
  const rows = await all("SELECT granted_key FROM wheel_spins WHERE kind='daily'");
  assert.equal(rows.length, 1, 'три обращения не должны создать три попытки');
});

test('AC3 попытка за каждую 1000 ₽ считается от накопленной суммы', async t => {
  // Три пополнения по 400 ₽ — это 1200 ₽ и одна попытка, а не ноль.
  const { wheel } = await fixture(t, { deposits: [400, 400, 400] });
  const state = await wheel.state(1);
  assert.equal(state.spins, 2, 'ежедневная + одна за 1200 ₽');
  assert.equal(state.toNextDepositSpin, 800);
});

test('AC4 повторный расчёт не выдаёт депозитные попытки заново', async t => {
  const { wheel, all } = await fixture(t, { deposits: [2500] });
  await wheel.state(1);
  await wheel.state(1);
  assert.equal((await all("SELECT id FROM wheel_spins WHERE kind='deposit'")).length, 2);
});

// --- Прокрут -----------------------------------------------------------------

test('AC5 прокрут тратит ровно одну попытку', async t => {
  const { wheel, all } = await fixture(t, { deposits: [1000] });
  assert.equal((await wheel.state(1)).spins, 2);
  await wheel.spin(1, 'req-aaaaaaaa');
  assert.equal((await all('SELECT id FROM wheel_spins WHERE consumed_at IS NOT NULL')).length, 1);
  assert.equal((await wheel.state(1)).spins, 1);
});

test('AC6 повтор того же requestId возвращает тот же приз и не жжёт вторую попытку', async t => {
  const { wheel, all } = await fixture(t, { deposits: [1000] });
  const first = await wheel.spin(1, 'req-double-click');
  const again = await wheel.spin(1, 'req-double-click');
  assert.equal(again.replayed, true);
  assert.equal(again.sectorCode, first.sectorCode);
  assert.equal((await all('SELECT id FROM wheel_spins WHERE consumed_at IS NOT NULL')).length, 1);
});

test('AC7 без попыток прокрут отклоняется, а не уходит в минус', async t => {
  const { wheel } = await fixture(t);
  await wheel.spin(1, 'req-first-one');
  await assert.rejects(() => wheel.spin(1, 'req-second-one'), e => e.code === 'NO_SPINS' && e.status === 409);
});

test('AC8 денежный приз начисляется и попадает в журнал операций', async t => {
  // roll 0 попадает в первый сектор кольца — 10 ₽.
  const { wheel, all } = await fixture(t, { rolls: [0] });
  const r = await wheel.spin(1, 'req-balance-1');
  assert.equal(r.prize.kind, 'balance');
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 1010);
  const tx = await all("SELECT type,amount FROM transactions WHERE type='wheel_win'");
  assert.deepEqual(tx.map(x => [x.type, x.amount]), [['wheel_win', 10]]);
});

test('AC9 скидочный приз создаёт скидку с сроком и порогом цены', async t => {
  // Сектора −15% начинаются после 6 копий по 10 ₽ и 5 по 25 ₽:
  // вес 2700+2100=4800 из 10000, значит roll 0.5 попадает в −15%.
  const { wheel, all } = await fixture(t, { rolls: [0.5] });
  const r = await wheel.spin(1, 'req-discount-1');
  assert.equal(r.prize.kind, 'discount');
  assert.equal(r.prize.percent, 15);
  const rows = await all('SELECT percent,max_case_price,used_at,expires_at FROM case_discounts');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].max_case_price, 299);
  assert.equal(rows[0].used_at, null);
  assert.ok(rows[0].expires_at, 'у скидки должен быть срок');
});

// --- Скидка при открытии кейса ----------------------------------------------

test('AC10 скидка гасится вместе со списанием и только один раз', async t => {
  const { wheel, run, all, queryAdminDb, getAdminDb } = await fixture(t);
  await run(`CREATE TABLE inventory(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, item_id INTEGER,
    market_hash_name TEXT, name TEXT, image TEXT, price REAL, rarity TEXT, color TEXT, source TEXT,
    source_ref TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT)`);
  await wheel.ensureSchema();
  await run(`INSERT INTO case_discounts(user_id,percent,max_case_price,source) VALUES(1,35,599,'test')`);

  const inventory = makeInventoryService({ queryAdminDb, getAdminDb, fixImageUrl: x => x });
  const discount = await wheel.bestDiscount(1, 100);
  assert.equal(discount.percent, 35);

  // Кейс за 100 ₽ со скидкой 35% стоит 65 ₽.
  await inventory.settleCase(1, { cost: 65, drops: [{ name: 'Item', price: 20, image: '', rarity: 'REGULAR' }],
    ref: 'Кейс', discountId: discount.id });
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 935);
  assert.equal((await all('SELECT used_at FROM case_discounts'))[0].used_at !== null, true);

  // Второе открытие с той же скидкой обязано провалиться целиком.
  await assert.rejects(
    () => inventory.settleCase(1, { cost: 65, drops: [{ name: 'Item', price: 20, image: '', rarity: 'REGULAR' }],
      ref: 'Кейс', discountId: discount.id }),
    e => e.code === 'DISCOUNT_SPENT');
  assert.equal((await all('SELECT balance FROM users WHERE id=1'))[0].balance, 935, 'откат: деньги не списаны');
  assert.equal(await wheel.bestDiscount(1, 100), null, 'использованная скидка больше не предлагается');
});

test('AC11 скидка не предлагается для кейса дороже своего порога', async t => {
  const { wheel, run } = await fixture(t);
  await wheel.ensureSchema();
  await run(`INSERT INTO case_discounts(user_id,percent,max_case_price,source) VALUES(1,35,599,'test')`);
  assert.equal(await wheel.bestDiscount(1, 1000), null);
  assert.ok(await wheel.bestDiscount(1, 599));
});

test('AC12 просроченная скидка не применяется', async t => {
  const { wheel, run } = await fixture(t);
  await wheel.ensureSchema();
  await run(`INSERT INTO case_discounts(user_id,percent,max_case_price,source,expires_at)
    VALUES(1,50,999,'test','2020-01-01T00:00:00.000Z')`);
  assert.equal(await wheel.bestDiscount(1, 100), null);
});

test('AC13 из нескольких скидок берётся самая выгодная', async t => {
  const { wheel, run } = await fixture(t);
  await wheel.ensureSchema();
  await run(`INSERT INTO case_discounts(user_id,percent,max_case_price,source) VALUES(1,15,599,'test')`);
  await run(`INSERT INTO case_discounts(user_id,percent,max_case_price,source) VALUES(1,35,599,'test')`);
  assert.equal((await wheel.bestDiscount(1, 100)).percent, 35);
});

test('AC14 гостю колесо показывается, но без попыток', async t => {
  const { wheel } = await fixture(t);
  const state = await wheel.state(null);
  assert.equal(state.spins, 0);
  assert.equal(state.guest, true);
  assert.equal(state.sectors.length, 24);
});
