'use strict';

/**
 * Целостность состава кейсов.
 *
 * Проблема, ради которой это написано: в case_items остались строки, ссылающиеся
 * на удалённые предметы. Их удалил старый синк командой
 *   DELETE FROM items WHERE image LIKE '%-9a81dl%'
 * (чистка сид-записей с обрезанными хэшами картинок), а связи в кейсах никто не
 * тронул — внешних ключей в схеме нет, поэтому база молча осталась битой.
 *
 * Последствие: getCaseItemsFromDb делает INNER JOIN и такие строки просто
 * исчезают. Кейс «Новый Мега Кейс 2026» за 499 ₽ остался с одним предметом за
 * 15 400 ₽ — то есть со стопроцентным шансом и отдачей 3086%. Каждое открытие
 * приносило бы владельцу убыток примерно в тридцать цен кейса.
 */

const sqlite3 = require('sqlite3').verbose();
const { ADMIN_DB_PATH } = require('./steamSync');

/** Выше этой отдачи открытие блокируется как заведомо убыточное. */
const MAX_RTP = Number(process.env.CASE_MAX_RTP || 150);

/** Минимум предметов, при котором кейс считается настроенным. */
const MIN_ITEMS = Number(process.env.CASE_MIN_ITEMS || 2);

function openDb() {
  try { return new sqlite3.Database(ADMIN_DB_PATH); } catch { return null; }
}
const all = (db, sql, p = []) => new Promise((r) => db.all(sql, p, (e, rows) => r(e ? [] : rows || [])));
const run = (db, sql, p = []) => new Promise((r) => db.run(sql, p, function (e) { r(e ? null : this); }));

/**
 * Удаляет строки case_items, ссылающиеся на несуществующие предметы.
 * Они и так невидимы из-за INNER JOIN, но мешают считать состав кейса и
 * вводят в заблуждение админку.
 */
async function cleanDanglingCaseItems(db) {
  const own = !db;
  const conn = db || openDb();
  if (!conn) return 0;

  const r = await run(conn, `
    DELETE FROM case_items
    WHERE item_id NOT IN (SELECT id FROM items)`);

  if (own) conn.close();
  const n = r ? r.changes : 0;
  if (n) console.log(`[Cases] Удалено битых связей case_items: ${n}`);
  return n;
}

/** Сводка по каждому кейсу: сколько предметов реально доступно. */
async function getCaseHealth() {
  const db = openDb();
  if (!db) return [];
  const rows = await all(db, `
    SELECT c.id, c.slug, c.name, c.price, c.archived,
           COUNT(ci.item_id) AS linked,
           SUM(CASE WHEN i.id IS NULL THEN 1 ELSE 0 END) AS broken,
           SUM(CASE WHEN i.id IS NOT NULL THEN 1 ELSE 0 END) AS usable,
           MIN(i.price) AS minPrice,
           MAX(i.price) AS maxPrice
    FROM cases c
    LEFT JOIN case_items ci ON ci.case_id = c.id
    LEFT JOIN items i ON i.id = ci.item_id
    GROUP BY c.id
    ORDER BY c.id`);
  db.close();

  return rows.map(r => {
    const problems = [];
    if (r.broken > 0) problems.push(`${r.broken} связей ведут на удалённые предметы`);
    if (r.usable < MIN_ITEMS) problems.push(`доступно предметов: ${r.usable} (нужно минимум ${MIN_ITEMS})`);
    if (r.usable > 0 && r.minPrice >= r.price) {
      problems.push(`самый дешёвый предмет (${r.minPrice} ₽) дороже кейса (${r.price} ₽) — отдача заведомо выше 100%`);
    }
    return { ...r, ok: problems.length === 0, problems };
  });
}

/** Кейсы, которые нельзя открывать в текущем виде. */
async function getBrokenCases() {
  return (await getCaseHealth()).filter(c => !c.ok && !c.archived);
}

module.exports = { cleanDanglingCaseItems, getCaseHealth, getBrokenCases, MAX_RTP, MIN_ITEMS };
