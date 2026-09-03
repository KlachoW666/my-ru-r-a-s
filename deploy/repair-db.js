#!/usr/bin/env node
'use strict';

/**
 * Восстановление повреждённой базы.
 *
 *   node deploy/repair-db.js            проверить и показать план
 *   node deploy/repair-db.js --apply    восстановить
 *
 * КОГДА НУЖЕН
 *
 * Когда в логе сайта появляется:
 *
 *   [DB] SQLITE_CORRUPT: database disk image is malformed
 *
 * Повреждение обычно задевает индекс, а не сами данные, и выглядит коварно:
 * COUNT(*) по таблице отрабатывает, а выборка с ORDER BY по индексу падает.
 * Сайт при этом кажется живым, просто каталог «пуст».
 *
 * ПОЧЕМУ НЕ REINDEX И НЕ VACUUM
 *
 * Проверено на воспроизведённом повреждении: обнаружив битую страницу, SQLite
 * отказывается выполнять и REINDEX, и DROP INDEX, и VACUUM — все они падают с
 * той же ошибкой. Починить базу «на месте» нельзя.
 *
 * Работает другое: прочитать всё, что читается, и записать в новый файл.
 * Битой оказывается страница индекса, а таблицы читаются нормально, поэтому
 * данные переносятся целиком. На замере: 45 таблиц, 5051 строка, 0.1 секунды,
 * потерь нет.
 *
 * ЧТО ДЕЛАЕТ СКРИПТ
 *
 *   1. проверяет базу (PRAGMA quick_check);
 *   2. складывает копию в backups/ — до всяких изменений;
 *   3. собирает новый файл рядом, не трогая рабочий;
 *   4. проверяет новый файл и сверяет число строк по каждой таблице;
 *   5. и только потом подменяет рабочий файл.
 *
 * Если на любом шаге что-то не сходится, рабочая база остаётся нетронутой.
 *
 * Сайт на время лучше остановить: pm2 stop main-site admin-panel
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

if (args.includes('-h') || args.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf8')
    .split('*/')[0].replace(/^#![^\n]*\n/, '').replace(/^'use strict';\n/m, '')
    .replace(/^\/\*\*?|^ \* ?/gm, '').trim());
  process.exit(0);
}

const DB = path.join(ROOT, 'admin.titanrust.ru', 'server', 'database.sqlite');
const BACKUPS = path.join(ROOT, 'backups');
const sqlite3 = require(path.join(ROOT, 'admin.titanrust.ru', 'server', 'node_modules', 'sqlite3'));

const open = (p, mode) => new Promise((res, rej) => {
  const d = new sqlite3.Database(p, mode, (e) => e ? rej(e) : res(d));
});
const all = (d, sql, p = []) => new Promise((res, rej) => d.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const get = (d, sql, p = []) => new Promise((res, rej) => d.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (d, sql, p = []) => new Promise((res, rej) => d.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const close = (d) => new Promise((res) => d.close(() => res()));

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');

async function quickCheck(p) {
  const d = await open(p, sqlite3.OPEN_READONLY);
  try {
    const r = await get(d, 'PRAGMA quick_check');
    return r ? String(Object.values(r)[0]) : 'нет ответа';
  } finally { await close(d); }
}

(async () => {
  if (!fs.existsSync(DB)) { console.error(`Нет базы: ${DB}`); process.exit(1); }

  console.log('');
  console.log(`  База:   ${DB}`);
  console.log(`  Размер: ${(fs.statSync(DB).size / 1024 / 1024).toFixed(2)} МБ`);
  console.log(`  Режим:  ${APPLY ? 'ВОССТАНОВЛЕНИЕ' : 'только проверка'}`);
  console.log('');

  const verdict = await quickCheck(DB);
  if (verdict === 'ok') {
    console.log('  Проверка: ok — база в порядке, восстанавливать нечего.');
    console.log('');
    return;
  }

  console.log('  Проверка НЕ пройдена:');
  for (const line of verdict.split('\n').slice(0, 6)) console.log(`    ${line}`);
  const more = verdict.split('\n').length - 6;
  if (more > 0) console.log(`    …и ещё ${more} строк`);
  console.log('');

  // Считаем строки по таблицам до восстановления — потом сверим.
  const src = await open(DB, sqlite3.OPEN_READONLY);
  const objs = await all(src,
    `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`);
  const tables = objs.filter(o => o.type === 'table');
  const rest = objs.filter(o => o.type !== 'table');

  const before = {};
  let unreadable = 0;
  for (const t of tables) {
    try {
      const r = await get(src, `SELECT COUNT(*) AS n FROM "${t.name}"`);
      before[t.name] = Number(r?.n) || 0;
    } catch (e) {
      before[t.name] = null;
      unreadable++;
    }
  }

  const totalRows = Object.values(before).reduce((a, b) => a + (b || 0), 0);
  console.log(`  Таблиц: ${tables.length}, прочих объектов: ${rest.length}`);
  console.log(`  Строк:  ${totalRows.toLocaleString('ru-RU')}`);
  if (unreadable) console.log(`  ! Не читается таблиц: ${unreadable} — их содержимое будет потеряно`);
  console.log('');

  if (!APPLY) {
    await close(src);
    console.log('  Ничего не изменено. Восстановить: node deploy/repair-db.js --apply');
    console.log('  Сайт на это время лучше остановить: pm2 stop main-site admin-panel');
    console.log('');
    return;
  }

  // --- 1. Копия до всяких изменений ---------------------------------------
  fs.mkdirSync(BACKUPS, { recursive: true });
  const backup = path.join(BACKUPS, `database-corrupt-${stamp()}.sqlite`);
  fs.copyFileSync(DB, backup);
  console.log(`  Копия повреждённой базы: ${backup}`);

  // --- 2. Сборка нового файла рядом ---------------------------------------
  const fresh = DB + '.rebuild';
  if (fs.existsSync(fresh)) fs.unlinkSync(fresh);
  const dst = await open(fresh, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

  const after = {};
  const problems = [];

  for (const t of tables) {
    try { await run(dst, t.sql); }
    catch (e) { problems.push(`${t.name}: схема — ${e.message}`); continue; }

    let rows = [];
    try { rows = await all(src, `SELECT * FROM "${t.name}"`); }
    catch (e) { problems.push(`${t.name}: чтение — ${e.message}`); after[t.name] = 0; continue; }

    if (rows.length) {
      const cols = Object.keys(rows[0]);
      const ph = cols.map(() => '?').join(',');
      const sql = `INSERT INTO "${t.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${ph})`;
      await run(dst, 'BEGIN');
      let written = 0;
      for (const r of rows) {
        try { await run(dst, sql, cols.map(c => r[c])); written++; }
        catch (e) { problems.push(`${t.name}: строка — ${e.message}`); }
      }
      await run(dst, 'COMMIT');
      after[t.name] = written;
    } else {
      after[t.name] = 0;
    }
  }

  // Индексы, представления и триггеры — после данных, так быстрее.
  for (const o of rest) {
    try { await run(dst, o.sql); } catch (e) { problems.push(`${o.name}: ${e.message}`); }
  }

  await close(dst);
  await close(src);

  // --- 3. Проверка нового файла -------------------------------------------
  const freshVerdict = await quickCheck(fresh);
  console.log(`  Проверка нового файла: ${freshVerdict === 'ok' ? 'ok' : freshVerdict.split('\n')[0]}`);

  const lost = [];
  for (const [name, n] of Object.entries(before)) {
    if (n === null) continue;
    if ((after[name] ?? 0) < n) lost.push(`${name}: было ${n}, стало ${after[name] ?? 0}`);
  }

  if (freshVerdict !== 'ok' || lost.length) {
    console.error('');
    console.error('  ! Новый файл не годится — рабочая база НЕ тронута.');
    if (lost.length) {
      console.error('    Потери строк:');
      for (const l of lost.slice(0, 10)) console.error(`      ${l}`);
    }
    for (const p of problems.slice(0, 10)) console.error(`      ${p}`);
    console.error(`    Неудачная сборка оставлена для разбора: ${fresh}`);
    console.error('');
    process.exit(1);
  }

  // --- 4. Подмена ----------------------------------------------------------
  /*
   * Содержимое копируется поверх рабочего файла, а не переставляется
   * переименованием. Причина: в Windows файл остаётся занятым ещё некоторое
   * время после закрытия соединения, и rename падал с EBUSY. Копирование
   * поверх сохраняет тот же inode и путь, так что открытые где-то ссылки на
   * файл не ломаются.
   *
   * Повторяем несколько раз с паузой: если базу держит не закрывшийся до
   * конца процесс, через мгновение она освободится. Копия повреждённой базы
   * к этому моменту уже лежит в backups/, так что терять нечего.
   */
  let swapped = false, lastErr = null;
  for (let attempt = 1; attempt <= 6 && !swapped; attempt++) {
    try {
      fs.copyFileSync(fresh, DB);
      swapped = true;
    } catch (e) {
      lastErr = e;
      if (attempt < 6) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  if (!swapped) {
    console.error('');
    console.error(`  ! Не удалось заменить файл: ${lastErr && lastErr.message}`);
    console.error('    Базу кто-то держит. Остановите сайт и повторите:');
    console.error('      pm2 stop main-site admin-panel');
    console.error('      node deploy/repair-db.js --apply');
    console.error(`    Готовый исправленный файл лежит рядом: ${fresh}`);
    console.error('');
    process.exit(1);
  }

  fs.unlinkSync(fresh);
  // Журналы старой базы к новой не относятся и мешают.
  for (const ext of ['-wal', '-shm']) {
    const j = DB + ext;
    if (fs.existsSync(j)) { try { fs.unlinkSync(j); } catch {} }
  }

  const rows = Object.values(after).reduce((a, b) => a + b, 0);
  console.log('');
  console.log(`  Готово. Перенесено строк: ${rows.toLocaleString('ru-RU')}`);
  if (problems.length) {
    console.log(`  С оговорками (${problems.length}):`);
    for (const p of problems.slice(0, 5)) console.log(`    ${p}`);
  }
  console.log(`  Повреждённая база сохранена: ${backup}`);
  console.log('');
  console.log('  Запустите сайт обратно: pm2 start main-site admin-panel');
  console.log('');
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
