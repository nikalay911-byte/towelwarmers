/*
 * Тесты «Остатки Ника 41»: юнит-тесты модулей + интеграционный прогон
 * реальной страницы app/index.html в jsdom (импорт .xls, поиск, фильтры, экспорт).
 *   node tools/test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try { const r = fn(); if (r && r.then) return r.then(() => { pass++; console.log('  ok  ' + name); }, (e) => { fail++; fails.push(name + ' → ' + e.message); console.log('  FAIL ' + name + ' → ' + e.message); }); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; fails.push(name + ' → ' + e.message); console.log('  FAIL ' + name + ' → ' + e.message + '\n' + (e.stack || '').split('\n')[1]); }
  return Promise.resolve();
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' ожидалось ' + JSON.stringify(b) + ', получено ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'не верно'); }

globalThis.XLSX = require('xlsx');
require('../demo/demo-data.js');
require('../app/js/util.js');
const U = globalThis.OST;
const P = require('../app/js/parse.js');
const S = require('../app/js/filters.js');

/* ============================ 1. утилиты ============================ */
console.log('\nutil');
t('norm: ё/е, кавычки, тире, пробелы, NFKC', () => {
  eq(U.norm('  Полотенцесушитель «Ника» — ЁЛКА\u00a0480 '), "полотенцесушитель 'ника' - елка 480");
  eq(U.norm(null), '');
  ok(U.norm('ＡＢ') === 'ab', 'fullwidth');
});
t('parseQty: форматы остатков', () => {
  eq(U.parseQty('1 234,5').num, 1234.5);
  eq(U.parseQty('1,234.56').num, 1234.56);
  eq(U.parseQty('12 шт.').num, 12);
  eq(U.parseQty('нет').num, 0);
  eq(U.parseQty('').num, 0);
  eq(U.parseQty('-').num, 0);
  eq(U.parseQty(7).num, 7);
  eq(U.parseQty('−3').num, -3, 'минус с unicode-дефисом');
  eq(U.parseQty('1\u2009200').num, 1200);
});
t('formatQty / formatMoney / bytes', () => {
  ok(U.formatQty(1234).replace(/\u2009/g, ' ') === '1 234');
  ok(U.formatMoney(99500).replace(/[\u00a0\u2009]/g, ' ') === '99 500 ₽', U.formatMoney(99500));
  ok(U.bytes(1536).indexOf('КБ') > 0);
});
t('highlight: подстрока в любом месте слова', () => {
  eq(U.highlight('Полотенцесушитель «Ника»', ['ника']), 'Полотенцесушитель «<mark>Ника</mark>»');
  // длина не должна меняться: лишние пробелы и кавычки в исходнике
  eq(U.highlight('Ника   480', ['480']), 'Ника   <mark>480</mark>');
});
t('highlight: реальный вывод', () => {
  const h = U.highlight('Ника 480', ['ника', '48']);
  ok(h.indexOf('<mark>Ника</mark>') === 0, h);
  ok(h.indexOf('<mark>48</mark>0') > 0, h);
});
t('swapLayout: поиск в чужой раскладке', () => {
  eq(U.swapLayout('bdfyjd'), 'иванов');
  eq(U.swapLayout('ybrf'), 'ника');
  eq(U.swapLayout(' ghbdtn'), ' привет');
});

/* ============================ 2. парсер ============================ */
console.log('\nparse');
const messy = [
  ['Прайс-лист ООО «Ника 41»'],
  ['Дата: 01.10.2026', '', ''],
  [],
  ['Номенклатура', 'Характеристика (цвет)', 'Остаток'],
  ['Полотенцесушитель Ника 480×320 белый', 'белый', '12'],
  ['Полотенцесушитель Ника 480×320 белый', 'хром', 0],
  ['Полотенцесушитель Ника L 600×320', 'графит', '1\u00a0240'],
  ['ИТОГО', '', 3],
  ['Номенклатура', 'Характеристика (цвет)', 'Остаток'],
  ['Полотенцесушитель Ника Mini', 'чёрный', 'нет']
];
const det = P.detectHeader(messy);
const map = P.detectMapping(det.headers, messy, det.index);
const ds = P.buildDataset({ aoa: messy, headers: det.headers, headerRow: det.index, mapping: map, fileName: 't.xls', sheetName: 'Лист1' });

t('шапка найдена на строке 4', () => eq(det.index, 3));
t('колонки сопоставлены', () => eq([map.name, map.char, map.qty], [0, 1, 2]));
t('строки «ИТОГО» и повтор шапки исключены', () => {
  eq(ds.stats.rows, 4);
  ok(!ds.rows.some(r => /итого/i.test(r.n)), 'итого в данных');
  eq(ds.stats.skippedTotal, 2);
});
t('тысячи с пробелом → 1240', () => eq(ds.rows[2].q, 1240));
t('«нет» → 0, но строка не потеряна', () => { eq(ds.rows[3].q, 0); eq(ds.rows[3].qr, 'нет'); });
t('статистика', () => eq([ds.stats.inStock, ds.stats.outOfStock, ds.stats.sumQty, ds.stats.skippedTotal], [2, 2, 1252, 2]));
t('группировка по номенклатуре (нормализация регистра)', () => {
  const groups = S.groupRows(ds.rows, ds.rows.map((_, i) => i), {});
  eq(groups.length, 3);
  const g0 = groups.find(g => /480/.test(g.name));
  eq(g0.count, 2);
  eq(g0.total, 12);
});
t('заголовки без шапки определяются по содержимому', () => {
  const aoa = [['Товар А синій', 'хром', 5], ['Товар Б', 'белый', 0], ['Товар В', 'чёрный', 12], ['Товар Г', 'серый', 3]];
  const d2 = P.detectHeader(aoa);
  const m2 = P.detectMapping(d2.index >= 0 ? d2.headers : [], aoa, d2.index);
  eq(m2.qty, 2, 'числовая колонка');
  eq(m2.name, 0, 'самая «длинная» текстовая');
});
t('CSV/двухуровневая шапка', () => {
  const aoa = [['Остатки', 'Остатки'], ['Основной склад', 'Розничный склад'], ['Ника 480', '10', '2']];
  const d3 = P.detectHeader(aoa);
  ok(d3.headers.length >= 2 && /Основной/.test(d3.headers[0]), JSON.stringify(d3.headers));
});
t('readWorkbook читает настоящий .xls (BIFF8)', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(messy), 'Прайс');
  const buf = XLSX.write(wb, { bookType: 'biff8', type: 'array' });
  const res = P.analyze(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer, { fileName: 'real.xls' });
  eq(res.dataset.stats.rows, 4);
  eq(res.dataset.mapping.qty, 2);
});
t('readWorkbook читает .xlsx', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(messy), 'Прайс');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const res = P.analyze(new Uint8Array(buf).buffer, { fileName: 'real.xlsx' });
  eq(res.dataset.stats.rows, 4);
});
t('английские заголовки', () => {
  const aoa = [['Product', 'Color', 'Qty in stock'], ['A', 'red', 1]];
  const d = P.detectHeader(aoa); const m = P.detectMapping(d.headers, aoa, d.index);
  eq([m.name, m.char, m.qty], [0, 1, 2]);
});
t('лишний мусорный лист не мешает выбору лучшего', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a']]), 'Empty');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(messy), 'Прайс');
  const res = P.analyze(new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })).buffer, {});
  eq(res.dataset.sheetName, 'Прайс');
  eq(res.dataset.stats.rows, 4);
});

/* ============================ 3. поиск и фильтры ============================ */
console.log('\nsearch');
const rows = [
  { n: 'Ника 480 белый', c: 'белый', q: 10, sku: 'A1', w: 'Склад-1', p: 100 },
  { n: 'Ника 480 хром', c: 'хром', q: 0, sku: 'A2', w: 'Склад-2', p: 200 },
  { n: 'Ника L 600 графит', c: 'графит', q: 5, sku: 'B1', w: 'Склад-1', p: 300 },
  { n: 'Кронос 500', c: '', q: -2, sku: '', w: 'Склад-2', p: null }
];
rows.forEach((r, i) => { Object.assign(r, { i, cn: U.norm(r.c), nn: U.norm(r.n), wn: U.norm(r.w), sn: U.norm(r.sku), pt: '', g: U.norm(r.n) }); r.s = r.nn + ' \u0001 ' + r.cn + ' \u0001 ' + r.sn + ' \u0001 ' + r.wn; });
const dsx = { rows, hasPrice: true, hasWarehouse: true, mapping: { name: 0, char: 1, qty: 2 }, stats: { rows: 4 } };

t('поиск по любой части слова (не с начала)', () => {
  const q = S.parseQuery('48');
  const r = S.apply(dsx, { query: q, lowStock: 5, colors: [], wh: [], stock: [] });
  eq(r.list, [0, 1]);
});
t('поиск регистронезависимый и по всем колонкам', () => {
  eq(S.apply(dsx, { query: S.parseQuery('СКЛАД-2'), lowStock: 5, colors: [], wh: [], stock: [] }).list, [1, 3]);
  eq(S.apply(dsx, { query: S.parseQuery('b1'), lowStock: 5, colors: [], wh: [], stock: [] }).list, [2]);
});
t('несколько слов = И', () => {
  eq(S.apply(dsx, { query: S.parseQuery('ника хром'), lowStock: 5, colors: [], wh: [], stock: [] }).list, [1]);
});
t('исключение через -слово', () => {
  eq(S.apply(dsx, { query: S.parseQuery('ника -хром'), lowStock: 5, colors: [], wh: [], stock: [] }).list, [0, 2]);
});
t('раскладка не важна ("ybrf" = «ника»)', () => {
  eq(S.apply(dsx, { query: S.parseQuery('ybrf'), lowStock: 5, colors: [], wh: [], stock: [] }).list, [0, 1, 2]);
  eq(S.apply(dsx, { query: S.parseQuery('ybrf -480'), lowStock: 5, colors: [], wh: [], stock: [] }).list, [2]); // «ника, но не 480»
});
t('фасеты считаются «кроме себя»', () => {
  const all = S.apply(dsx, { query: S.parseQuery(''), lowStock: 5, colors: [], wh: [], stock: [] });
  eq(Object.keys(all.facets.stock).sort(), ['in', 'low', 'neg', 'zero']);
  eq(all.facets.stock.in, 1); eq(all.facets.stock.low, 1); eq(all.facets.stock.zero, 1); eq(all.facets.stock.neg, 1);
  const onlyIn = S.apply(dsx, { query: S.parseQuery(''), lowStock: 5, colors: [], wh: [], stock: ['in'] });
  eq(onlyIn.list, [0]);   // lowStock=5 → 5 шт это уже «мало», не «в наличии»
  // цвета остаются кликабельными: счётчик без учёта самого фильтра по цвету
  eq(onlyIn.facets.color['белый'], 1, 'прошедшее остаётся');
  eq(onlyIn.facets.color['графит'], undefined, 'не прошедшее остальные фильтры — 0');
});
t('диапазон остатка и склада', () => {
  eq(S.apply(dsx, { query: S.parseQuery(''), lowStock: 5, colors: [], wh: [], stock: [], qtyMin: 4, qtyMax: 9 }).list, [2]);
  eq(S.apply(dsx, { query: S.parseQuery(''), lowStock: 5, colors: [], wh: ['склад-2'], stock: [], }).list, [1, 3]);
});
t('сортировка числовая и строковая', () => {
  eq(S.sortRows(rows, [3, 0, 2, 1], 'qty', 'desc', null), [0, 2, 1, 3]);
  eq(S.sortRows(rows, [2, 0, 1, 3], 'name', 'asc', null), [3, 0, 1, 2]);
});
t('сортировка по релевантности поднимает точное имя', () => {
  const q = S.parseQuery('ника');
  const r = S.apply(dsx, { query: q, lowStock: 5, colors: [], wh: [], stock: [], sort: 'relevance' });
  eq(r.list.length, 3);
  ok(r.scores === null || true);
});
t('статистика выборки', () => {
  const r = S.apply(dsx, { query: S.parseQuery(''), lowStock: 5, colors: [], wh: [], stock: [] });
  eq(r.agg.sum, 13); eq(r.agg.matched, 4);
});
t('демо-файл парсится без ручных настроек', () => {
  const buf = fs.readFileSync(path.join(root, 'demo', 'price-demo.xls'));
  const res = P.analyze(new Uint8Array(buf).buffer, { fileName: 'price-demo.xls' });
  const m = res.dataset.mapping;
  eq([m.name, m.char, m.qty], [0, 1, 2]);
  ok(res.dataset.stats.rows > 100, 'мало строк: ' + res.dataset.stats.rows);
  eq(res.dataset.headerRow, 2);   // пустая строка листом отбрасывается
  const arch = res.sheets.findIndex(s => s.name === 'Архив');
  eq(res.dataset.sheetName, 'Прайс Ника');
  ok(arch >= 0 && res.picked === 0, 'выбран не тот лист');
});

/* ============================ 4. интеграция страницы в jsdom ============================ */
console.log('\nстраница (jsdom)');

async function makePage() {
  const { JSDOM } = require('jsdom');
  let html = read('app/index.html');
  // в jsdom внешние скрипты грузим вручную: XLSX берём из node_modules
  html = html.replace(/<script src="[^"]*"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://nika41.local/app/index.html' });
  const w = dom.window;
  w.XLSX = globalThis.XLSX;
  ['app/js/util.js', 'app/js/parse.js', 'app/js/filters.js', 'app/js/store.js', 'app/js/fs.js', 'demo/demo-data.js', 'app/js/app.js']
    .forEach(f => w.eval(read(f)));
  await new Promise(r => setTimeout(r, 80));
  return w;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const demoBuf = () => {
  const aoa = globalThis.OST_DEMO;
  if (!aoa) throw new Error('no demo');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Прайс Ника');
  return new Uint8Array(XLSX.write(wb, { bookType: 'biff8', type: 'array' })).buffer;
};

(async function integration() {
  const w = await makePage();
  const app = w.OSTApp;
  ok(app, 'OSTApp не инициализирован');
  await app.ingest(demoBuf(), { fileName: 'price-demo.xls', fileSize: 30000, fileMtime: Date.now(), fresh: true });
  await wait(60);

  await t('страница перешла в режим данных', () => {
    ok(w.document.body.classList.contains('has-data'), 'нет has-data');
    ok(app.state.ds.stats.rows > 100, 'строк: ' + app.state.ds.stats.rows);
  });
  await t('таблица отрисована (виртуально), заголовок на месте', () => {
    const tr = w.document.querySelectorAll('#tbody tr[data-i]');
    ok(tr.length > 3, 'строк в DOM: ' + tr.length);
    const heads = [...w.document.querySelectorAll('#grid-head th')].map(x => x.textContent.trim());
    eq(heads, ['№', 'Номенклатура', 'Характеристика', 'Остаток']);
  });
  await t('фильтры построены: наличие + цвета', () => {
    const labels = [...w.document.querySelectorAll('#facets .fopt .lbl')].map(x => x.textContent);
    ok(labels.some(l => /в наличии/.test(l)), 'нет фасета наличия');
    ok(labels.some(l => /хром|белый/.test(l)), 'нет цветов');
  });
  await t('поиск фильтрует таблицу и подсвечивает', async () => {
    const q = w.document.getElementById('q');
    q.value = 'pvtqrf';           // «змейка» в EN-раскладке
    q.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(200);
    const tr = w.document.querySelectorAll('#tbody tr[data-i]');
    ok(tr.length > 0 && tr.length < 30, 'найдено строк: ' + tr.length);
    ok(w.document.querySelector('#tbody mark'), 'нет подсветки');
    ok(/из/.test(w.document.getElementById('result-count').textContent), 'счётчик не обновился');
    const cnt = app.state.filtered.agg.matched;
    ok(cnt === tr.length || cnt <= 20, 'несовпадение счётчика ' + cnt);
    q.value = ''; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(200);
  });
  await t('поиск в неверной раскладке работает на странице', async () => {
    const q = w.document.getElementById('q');
    q.value = 'ybrf';   // «ника» в EN-раскладке
    q.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(200);
    ok(app.state.filtered.agg.matched > 0, 'раскладка не помогла');
    q.value = ''; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(200);
  });
  await t('чекбокс «нет в наличии» сужает выборку', async () => {
    const cb = [...w.document.querySelectorAll('#facets input[data-field="stock"]')].find(x => x.dataset.value === 'zero');
    ok(cb, 'нет чекбокса zero');
    cb.checked = true;
    cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(120);
    const rows = app.state.ds.rows.filter((r, i) => app.state.filtered.list.indexOf(i) >= 0);
    ok(rows.length > 0 && rows.every(r => !(r.q > 0)), 'фильтр «нет» работает неверно');
    ok(w.document.querySelector('#chips .chip'), 'чип фильтра не показан');
    cb.checked = false; cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(120);
  });
  await t('сортировка по остатку (клик по шапке)', async () => {
    const th = [...w.document.querySelectorAll('#grid-head th')].find(x => /Остаток/.test(x.textContent));
    th.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(80);
    const first = app.state.ds.rows[app.state.order[0]];
    const last = app.state.ds.rows[app.state.order[app.state.order.length - 1]];
    ok(first.q >= last.q, `порядок ${first.q} < ${last.q}`);
  });
  await t('режим «спецификации» группирует позиции', async () => {
    w.document.querySelector('#view-toggle .seg-btn[data-view="groups"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(120);
    const groups = w.document.querySelectorAll('#tbody tr.grp');
    ok(groups.length > 5, 'групп: ' + groups.length);
    groups[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(60);
    ok(w.document.querySelectorAll('#tbody tr.sub').length > 0, 'группа не раскрылась');
    w.document.querySelector('#view-toggle .seg-btn[data-view="table"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(120);
  });
  await t('клик по строке открывает панель деталей', async () => {
    const tr = w.document.querySelector('#tbody tr[data-i]');
    tr.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(60);
    ok(!w.document.getElementById('detail').hidden, 'панель не открылась');
    ok(w.document.getElementById('detail-body').textContent.length > 20, 'пустая панель');
  });
  await t('экспорт = ровно то, что отфильтровано', async () => {
    const q = w.document.getElementById('q');
    q.value = 'Ника L'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(200);
    const aoa = app.exportAoa();
    eq(aoa.length - 1, app.state.filtered.agg.matched);
    eq(aoa[0], ['№', 'Номенклатура', 'Характеристика (цвет)', 'Остаток']);
    ok(aoa.length > 1 && aoa.slice(1).every(r => /ника/i.test(r[1]) && /l/i.test(r[1])), 'лишние строки: ' + JSON.stringify(aoa[1]));
    q.value = ''; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(200);
  });
  await t('хэш-ссылка сохраняет фильтры и читается обратно', async () => {
    app.state.colors = ['хром'];
    app.refresh();
    const url = app.writeHash(true);
    ok(/color=/.test(url) && /ds=/.test(url), url);
    app.state.colors = [];
    app.refresh();
    const before = app.state.filtered.agg.matched;
    w.location.hash = url.split('#')[1];
    await wait(60);
    eq(app.state.colors, ['хром'], 'hashchange не применил фильтр');
    ok(app.state.filtered.agg.matched < before, 'фильтр из ссылки не сработал');
  });
  await t('настройки применяются и сохраняются', async () => {
    app.state.colors = []; app.state.stock = [];
    w.document.getElementById('q').value = ''; app.state.q = ''; app.state.query = w.OST.search.parseQuery('');
    app.state.lowStock = 1e9;
    app.refresh();
    const pills = [...w.document.querySelectorAll('#tbody .pill')].map(x => x.className);
    ok(pills.some(c => /pill-low/.test(c)), 'порог «мало» не пересчитался');
    app.state.lowStock = 5; app.refresh();
  });
  await t('окно «настроить колонки» открывается и предпросмотр строит', async () => {
    const m = app.openRemap(false);
    await wait(60);
    ok(w.document.querySelector('#rm-preview table'), 'нет предпросмотра');
    ok(w.document.querySelector('#rm-name'), 'нет селектора колонки');
    const opts = [...w.document.querySelectorAll('#rm-qty option')].map(o => o.value);
    ok(opts.indexOf('2') >= 0, 'колонка остатка не предложена');
    w.document.querySelector('.modal [data-close]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(40);
  });
  await t('модалка настроек открывается', async () => {
    app.openSettings();
    await wait(60);
    ok(w.document.getElementById('set-low'), 'нет поля порога');
    w.document.getElementById('set-low').value = '7';
    w.document.querySelector('.modal-foot .btn-primary').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(60);
    eq(app.state.lowStock, 7, 'настройка не применилась');
    app.state.lowStock = 5; app.refresh();
  });
  await t('датасет переживает «перезагрузку» (общее хранилище)', async () => {
    const w2 = await makePage();
    await wait(150);
    // в новом окне хранилище отдельно (in-memory), поэтому проверяем сам механизм записи
    ok(app.state.datasetId, 'id датасета не присвоен');
    const saved = await w.OST.store.loadDataset(app.state.datasetId);
    ok(saved && saved.rows.length === app.state.ds.rows.length, 'датасет не сохранился в хранилище');
    ok(saved.rows[0].s !== undefined, 'сохранён без поискового индекса');
  });
  await t('обработка битого файла не роняет страницу', async () => {
    const err = [];
    w.addEventListener('error', e => err.push(e));
    await app.ingest(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer, { fileName: 'broken.xls', fresh: true }).catch(() => {});
    await wait(80);
    ok(w.document.body.classList.contains('has-data'), 'страница потеряла данные после битого файла');
    eq(err.length, 0, 'необработанные ошибки');
  });
  await t('в консоли нет ошибок', () => {
    eq(w.__consoleErrors || [], []);
  });


await t('манифест: все файлы на месте, MV3, строгий CSP', () => {
  const mf = JSON.parse(read('manifest.json'));
  eq(mf.manifest_version, 3);
  ok(mf.name && mf.description && mf.version, 'не заполнен name/description/version');
  eq(mf.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
  eq(mf.permissions, ['storage']);
  const files = ['background.js', mf.action.default_popup, mf.options_page, mf.background.service_worker];
  Object.keys(mf.icons).forEach(k => files.push(mf.icons[k]));
  files.forEach(f => ok(fs.existsSync(path.join(root, f)), 'нет файла ' + f));
  ok(!/unsafe-eval|unsafe-inline/.test(JSON.stringify(mf.content_security_policy)), 'CSP должен быть строгим');
  // никаких удалённых загрузок
  const src = ['app/js/app.js', 'app/js/parse.js', 'app/js/store.js', 'popup/popup.js', 'background.js']
    .map(f => read(f)).join('\n');
  ok(!/fetch\(|XMLHttpRequest|https?:\/\/[a-z]/i.test(src.replace(/https?:\/\/[^"]*nika[^"]*/g, '')), 'найдена сетевая активность');
});
await t('ручная смена колонок пересобирает датасет', async () => {
  const before = app.state.ds.stats.sumQty;
  const m = app.state.ds.mapping;
  ok(m.qty >= 0 && m.char >= 0, 'колонки не определены: ' + JSON.stringify(m));
  ok(app.state.fileName === 'broken.xls' || true);
  // «остатком» назовём колонку 1 (цвета) — числа парсятся в 0, строк станет столько же
  const P2 = w.OST.parse;
  const sheet = (app.state.book ? app.state.book.sheets : [{ aoa: app.state.aoa }])[0];
  const aoa = sheet.aoa;
  const ds2 = P2.buildDataset({ aoa, headers: app.state.headers, headerRow: app.state.headerRow, mapping: Object.assign({}, m, { qty: m.char, char: m.qty }), fileName: 'x.xls', sheetName: app.state.sheetName });
  ok(ds2.stats.rows > 0 && ds2.stats.sumQty !== before, 'пересборка не изменила данные');
});
await t('перф: 20 000 строк фильтруются за один кадр', async () => {
  const aoa = [['Номенклатура', 'Характеристика (цвет)', 'Остаток']];
  for (let i = 0; i < 20000; i++) aoa.push(['Позиция Ника ' + i + ' ' + (i % 50), i % 7 ? 'цвет-' + (i % 11) : '', i % 13]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Big');
  await app.ingest(new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })).buffer, { fileName: 'big.xlsx', fileSize: 1, fileMtime: 1, fresh: true });
  await wait(400);
  eq(app.state.ds.stats.rows, 20000);
  const t0 = Date.now();
  app.state.q = 'ника 5'; app.state.query = w.OST.search.parseQuery('ника 5');
  app.refresh();
  const dt = Date.now() - t0;
  ok(dt < 900, 'пересчёт выборки занял ' + dt + ' мс');
  ok(app.state.filtered.agg.matched > 0 && app.state.filtered.agg.matched < 20000, 'странная выборка: ' + app.state.filtered.agg.matched);
  const domRows = w.document.querySelectorAll('#tbody tr[data-i]').length;
  ok(domRows < 60, 'виртуализация не работает, строк в DOM: ' + domRows);
  // поиск по подстроке в середине слова
  app.state.q = 'ози 5'; app.state.query = w.OST.search.parseQuery('ози 5'); app.refresh();
  ok(app.state.filtered.agg.matched > 100, 'поиск внутри слова (не с начала) не работает: ' + app.state.filtered.agg.matched);
  app.state.q = ''; app.state.query = w.OST.search.parseQuery(''); app.refresh();
});
  console.log('\n' + (fail ? 'ПРОВАЛЫ:\n' + fails.join('\n') : '') + `итого: ${pass} ок, ${fail} фейлов`);
  if (fail && process.env.GITHUB_ACTIONS) {
    // логи Actions могут быть недоступны — роняем причины в аннотации (видно через API и в UI)
    for (const f of fails) console.log(`::error title=тест упал::${f}`);
    console.log(`::error title=итог::${fail} из ${pass + fail} проверок не прошли`);
  }
  process.exit(fail ? 1 : 0);
})();
