#!/usr/bin/env node
'use strict';

/**
 * Обновление цен каталога из lis-skins.com.
 *
 * Смена цен меняет экономику: от стоимости предмета зависят выплаты, RTP
 * кейсов и цена входа в баттлы. Поэтому по умолчанию скрипт ничего не пишет —
 * только показывает, что изменится.
 *
 *   node deploy/prices.js                          сравнить, ничего не менять
 *   node deploy/prices.js --apply                  записать новые цены
 *   node deploy/prices.js --field unlocked_price   другое поле цены
 *
 * Сервер делает то же самое сам, раз в полчаса (PRICE_REFRESH_MS). Скрипт
 * нужен, чтобы посмотреть расхождение до того, как оно применится, и чтобы
 * обновить цены разово, не дожидаясь таймера.
 *
 * Редкость, цвет и картинки не трогаются никогда: в выгрузке lis-skins их нет,
 * их источник — обход Steam Market.
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const fieldIdx = args.indexOf('--field');
if (fieldIdx !== -1 && args[fieldIdx + 1]) process.env.LISSKINS_PRICE_FIELD = args[fieldIdx + 1];

if (args.includes('-h') || args.includes('--help')) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, '').trim());
  process.exit(0);
}

const catalog = require(path.join(ROOT, 'services', 'steamCatalog'));
const api = require(path.join(ROOT, 'services', 'lisSkins'));

const run = (db, sql, p = []) => new Promise((res) => db.run(sql, p, function (e) { res(e ? null : this); }));
const all = (db, sql, p = []) => new Promise((res) => db.all(sql, p, (e, r) => res(e ? [] : r || [])));

const money = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

(async () => {
  const db = catalog.openDb();
  if (!db) { console.error('Не открылась база'); process.exit(1); }

  await catalog.ensureCatalogSchema(db);
  // Курс нужен до пересчёта: цены в выгрузке долларовые.
  await catalog.refreshFxRate();

  console.log('');
  console.log('  Источник:   lis-skins.com');
  console.log(`  Поле цены:  ${api.PRICE_FIELD}`);
  console.log(`  Режим:      ${APPLY ? 'ЗАПИСЬ' : 'только сравнение'}`);
  console.log('  Загружаю каталог одним запросом…');

  const r = await api.refreshPrices({
    db, run, all,
    usdToRub: (usd) => catalog.usdCentsToRub(Math.round(Number(usd) * 100)),
    dryRun: !APPLY
  });

  if (!r.ok) {
    console.error(`\n  Не получилось: ${r.message}\n`);
    db.close();
    process.exit(1);
  }

  console.log('');
  console.log(`  Пришло из выгрузки:  ${r.fromApi}`);
  console.log(`  Есть в каталоге:     ${r.inCatalog}`);
  console.log(`  Совпало и обновится: ${r.updated}`);
  console.log(`  Нет у нас:           ${r.unknown}  (заводит их обход Steam — здесь нет редкости)`);
  console.log(`  Без цены:            ${r.skipped}`);
  console.log('');
  console.log(`  Сумма каталога была: ${money(r.sumOld)}`);
  console.log(`  Станет:              ${money(r.sumNew)}`);
  console.log(`  Сдвиг:               ${r.shiftPercent > 0 ? '+' : ''}${r.shiftPercent}%   (дороже ${r.grew}, дешевле ${r.fell})`);
  if (r.updatedAt) console.log(`  Данные на:           ${r.updatedAt}`);

  if (r.biggest.length) {
    console.log('');
    console.log('  Сильнее всего разойдутся:');
    for (const b of r.biggest) {
      console.log(`    ${String(b.diff + '%').padStart(6)}  ${money(b.oldRub).padStart(12)} -> ${money(b.rub).padStart(12)}  ${b.name}`);
    }
  }

  console.log('');
  if (!APPLY) {
    console.log('  Ничего не записано. Устраивает — повторите с --apply');
    if (Math.abs(r.shiftPercent) > 15) {
      console.log('');
      console.log(`  ! Сдвиг ${r.shiftPercent}% заметный, он сдвинет и RTP кейсов.`);
      console.log('    После записи проверьте:');
      console.log('    curl -s http://127.0.0.1:3101/api/v1/cases/health');
    }
  } else {
    console.log('  Цены записаны. Редкость, цвет и картинки не тронуты.');
  }
  console.log('');
  db.close();
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
