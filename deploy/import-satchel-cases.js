#!/usr/bin/env node
'use strict';

/**
 * Подключение артов SATCHEL к кейсам каталога.
 *
 *   node deploy/import-satchel-cases.js              показать план, не писать
 *   node deploy/import-satchel-cases.js --apply      записать пути картинок
 *   node deploy/import-satchel-cases.js --create     завести недостающие кейсы
 *
 * Что делает. В public/assets/cases/satchel лежат 20 артов и manifest.json.
 * Скрипт сопоставляет их с кейсами в базе админки и проставляет им поле
 * image. По умолчанию НИЧЕГО не пишет — только показывает, что изменится.
 *
 * Почему по умолчанию сухой прогон и почему --create отдельным флагом:
 * каталог кейсов — это экономика. У кейса есть цена, состав и отдача, и
 * заведение пустого кейса создаёт запись, которую сервер потом заблокирует
 * («связей нет, доступно 0 предметов»). Картинку подставить безопасно,
 * создать кейс — нет, поэтому это два разных решения.
 *
 * Сопоставление идёт по slug. Арт breach.webp встанет кейсу со slug breach.
 * Всё, что не совпало, выводится списком: такие кейсы заводятся в админке
 * вручную, вместе с ценой и составом.
 *
 * Состав, цены, шансы и RTP скрипт не трогает вообще.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CREATE = args.includes('--create');

if (args.includes('-h') || args.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf8')
    .split('*/')[0].replace(/^#![^\n]*\n/, '').replace(/^'use strict';\n/m, '')
    .replace(/^\/\*\*?|^ \* ?/gm, '').trim());
  process.exit(0);
}

const MANIFEST = path.join(ROOT, 'public', 'assets', 'cases', 'satchel', 'manifest.json');
const DB_PATH = path.join(ROOT, 'admin.titanrust.ru', 'server', 'database.sqlite');

if (!fs.existsSync(MANIFEST)) {
  console.error(`Нет манифеста: ${MANIFEST}`);
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`Нет базы: ${DB_PATH}`);
  process.exit(1);
}

const sqlite3 = require(path.join(ROOT, 'admin.titanrust.ru', 'server', 'node_modules', 'sqlite3'));
const db = new sqlite3.Database(DB_PATH);
db.configure('busyTimeout', 10000);

const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const cases = await all('SELECT id, slug, name, image FROM cases');
  const bySlug = new Map(cases.map(c => [String(c.slug || '').toLowerCase(), c]));

  const matched = [];
  const missing = [];
  for (const art of manifest.cases) {
    // Картинка должна реально лежать на диске: битый путь хуже старого арта.
    const file = path.join(ROOT, 'public', art.image.replace(/^\//, '').replace(/\//g, path.sep));
    if (!fs.existsSync(file)) {
      console.error(`  ! нет файла: ${art.image}`);
      continue;
    }
    const hit = bySlug.get(art.slug.toLowerCase());
    (hit ? matched : missing).push({ art, row: hit });
  }

  console.log('');
  console.log(`  Артов в манифесте:   ${manifest.cases.length}`);
  console.log(`  Кейсов в базе:       ${cases.length}`);
  console.log(`  Совпало по slug:     ${matched.length}`);
  console.log(`  Нет кейса под арт:   ${missing.length}`);
  console.log(`  Режим:               ${APPLY ? 'ЗАПИСЬ' : 'только план'}${CREATE ? ' + создание кейсов' : ''}`);

  if (matched.length) {
    console.log('');
    console.log('  Получат новый арт:');
    for (const m of matched) {
      const same = m.row.image === m.art.image;
      console.log(`    ${same ? '=' : '→'} ${m.art.slug.padEnd(16)} ${String(m.row.image || '—').slice(0, 44)}`);
      if (APPLY && !same) {
        await run('UPDATE cases SET image = ? WHERE id = ?', [m.art.image, m.row.id]);
      }
    }
  }

  if (missing.length) {
    console.log('');
    console.log('  Кейса под арт нет:');
    for (const m of missing) {
      console.log(`    · ${m.art.slug.padEnd(16)} ${m.art.category.padEnd(9)} ${m.art.name}`);
    }
    if (CREATE && APPLY) {
      console.log('');
      console.log('  Создаю пустые кейсы. ВНИМАНИЕ: без цены и состава сервер');
      console.log('  заблокирует их открытие, пока состав не задан в админке.');
      for (const m of missing) {
        await run(
          `INSERT INTO cases (slug, name, price, image, category, archived, status, isActive)
           VALUES (?, ?, 0, ?, ?, 0, 'draft', 0)`,
          [m.art.slug, m.art.name, m.art.image, m.art.category]);
        console.log(`    + ${m.art.slug}`);
      }
    } else if (!CREATE) {
      console.log('');
      console.log('  Завести их: повторите с --create --apply, затем задайте в');
      console.log('  админке цену и состав. Либо создайте кейсы вручную — арт');
      console.log('  подставится следующим запуском с --apply.');
    }
  }

  console.log('');
  if (!APPLY) console.log('  Ничего не записано. Устраивает — повторите с --apply');
  else console.log('  Готово. Цены, состав, шансы и RTP не тронуты.');
  console.log('');
  db.close();
})().catch((e) => { console.error('Ошибка:', e.message); db.close(); process.exit(1); });
