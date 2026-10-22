/*
 * Мини-бенчмарк: сколько стоит импорт и поиск на реальном объёме.
 *   node tools/bench.mjs [число_строк]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.XLSX = require('xlsx');
const N = +(process.argv[2] || 100000);

require('../app/js/util.js');
const U = globalThis.OST;
const P = require('../app/js/parse.js');
const S = require('../app/js/filters.js');

const COLORS = ['белый', 'хром', 'чёрный', 'графит', 'бежевый', 'серый', 'золото', 'серебро'];
const aoa = [['Номенклатура', 'Характеристика (цвет)', 'Остаток', 'Артикул', 'Склад', 'Цена']];
for (let i = 0; i < N; i++) {
  aoa.push([
    `Полотенцесушитель Ника ${100 + (i % 400)}×${200 + (i % 300)} модель-${i}`,
    COLORS[i % COLORS.length],
    i % 17 === 0 ? 'нет' : (i % 97 === 0 ? String(1000 + (i % 4000)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : i % 50),
    'ART' + (100000 + i),
    'Склад-' + (1 + i % 4),
    (1500 + (i % 900) * 7) + (i % 3 ? 0.5 : 0)
  ]);
}
const t = (label, fn) => { const a = process.hrtime.bigint(); const r = fn(); const b = process.hrtime.bigint(); console.log(`${label.padEnd(34)} ${Number(b - a) / 1e6 | 0} мс`); return r; };

const det = t('поиск строки заголовка', () => P.detectHeader(aoa));
const map = t('определение колонок', () => P.detectMapping(det.headers, aoa, det.index));
console.log('маппинг:', JSON.stringify({ name: map.name, char: map.char, qty: map.qty, sku: map.sku, price: map.price, warehouse: map.warehouse }));
const ds = t('построение датасета', () => P.buildDataset({ aoa, headers: det.headers, headerRow: det.index, mapping: map }));
t('поисковый индекс (синхронно)', () => { for (const r of ds.rows) { r.cn = U.norm(r.c); r.nn = U.norm(r.n); r.wn = U.norm(r.w); r.sn = U.norm(r.sku); r.s = r.nn + ' \u0001 ' + r.cn + ' \u0001 ' + r.sn + ' \u0001 ' + r.wn; } });

const fakeRoot = {};
for (const q of ['ника 480', 'хром склад-2', 'арт100', 'суш', 'ника -хром']) {
  const query = S.parseQuery(q);
  const r1 = t(`фильтр «${q}»`, () => S.apply(ds, { query, colors: [], wh: [], stock: [], lowStock: 5, qtyMin: null, qtyMax: null, priceMin: null, priceMax: null, sort: 'relevance' }));
  t(`сортировка (${q})`, () => S.sortRows(ds.rows, r1.list, 'relevance', 'asc', r1.scores));
}
const r2 = t('фильтр без поиска', () => S.apply(ds, { query: S.parseQuery(''), colors: [], wh: [], stock: ['in'], lowStock: 5, qtyMin: 10, qtyMax: null, priceMin: null, priceMax: null }));
t('группировка', () => S.groupRows(ds.rows, r2.list, {}));
console.log('строк в датасете:', ds.stats.rows, '| совпадений:', r2.agg.matched);
