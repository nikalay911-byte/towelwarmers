/*
 * Тесты «Монитора цен»: ядро (расписание, цены, CSV), извлечение цены в jsdom
 * и прогон service worker'а на имитации chrome.* API (полный круг с паузами и блокировкой сайта).
 *   node price-monitor/test/test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { JSDOM } = require('jsdom');
const PM = require('../lib/core.js');
const X = require('../lib/extract.js');

let pass = 0, fail = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; fails.push(name + ' → ' + e.message); console.log('  FAIL ' + name + ' → ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n')); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg ? msg + ': ' : '') + 'ожидалось ' + JSON.stringify(b) + ', получено ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'не верно'); }
const page = (html, url = 'https://shop.example.ru/p/1') => new JSDOM(html, { url, pretendToBeVisual: true }).window.document;

/* ============================ ядро ============================ */
console.log('\ncore');
await t('parsePrice: форматы', () => {
  eq(PM.parsePrice('23 715 ₽'), 23715);
  eq(PM.parsePrice('23\u00a0715 руб.'), 23715);
  eq(PM.parsePrice('Цена: 1\u2009999,90'), 1999.9);
  eq(PM.parsePrice('23715.00'), 23715);
  eq(PM.parsePrice('-15% 27 900'), 27900, 'процент пропускаем');
  eq(PM.parsePrice('нет'), null);
  eq(PM.parsePrice(31000), 31000);
});
await t('deviation и демпинг — формула из ТЗ', () => {
  eq(PM.deviation(23715, 27900), -15);
  eq(PM.deviation(25800, 27900), -7.53);
  eq(PM.deviation(31000, 34100), -9.09);
  eq(PM.deviation(27900, 27900), 0);
  eq(PM.isDumping(27900, 27900, 0), false, 'равная цена — не демпинг');
  eq(PM.isDumping(27800, 27900, 0), true);
  eq(PM.isDumping(27800, 27900, 1), false, 'порог 1%');
  eq(PM.deviation(null, 100), null);
});
await t('домены: host/site/исключения/разрешения', () => {
  eq(PM.hostOf('https://www.santehtop.ru/x'), 'santehtop.ru');
  eq(PM.siteOf('https://tver.santehnica.ru/p'), 'santehnica.ru');
  eq(PM.siteOf('https://shop.example.co.uk/'), 'example.co.uk');
  ok(PM.isExcluded('https://www.comfysan.ru/catalog', PM.DEFAULT_SETTINGS.excludedDomains));
  ok(PM.isExcluded('https://msk.polotenhik.ru/', PM.DEFAULT_SETTINGS.excludedDomains), 'поддомен исключённого');
  ok(!PM.isExcluded('https://notcomfysan.ru/', PM.DEFAULT_SETTINGS.excludedDomains), 'похожий домен не исключаем');
  eq(PM.originPatterns(['https://www.santehtop.ru/a', 'https://santehtop.ru/b', 'https://tver.santehnica.ru/']), ['*://*.santehnica.ru/*', '*://*.santehtop.ru/*']);
});
await t('очередь: исключённые домены выкинуты, один сайт подряд не повторяется', () => {
  const pos = PM.normalizePositions([
    { name: 'A', article: '1', ourPrice: 100, links: ['https://a.ru/1', 'https://a.ru/2', 'https://a.ru/3', 'https://b.ru/1', 'https://c.ru/1', 'https://comfysan.ru/x'] },
    { name: 'B', article: '2', ourPrice: 100, links: ['https://b.ru/2', 'https://c.ru/2'] }
  ]);
  const q = PM.buildQueue(pos, {});
  eq(q.length, 7);
  const sites = q.map((id) => PM.siteOf(PM.findLink(pos, id).link.url));
  for (let i = 1; i < sites.length; i++) ok(sites[i] !== sites[i - 1], 'подряд один сайт: ' + sites.join(','));
});
await t('pickNext: пауза по сайту и минимальный интервал на сайт', () => {
  const pos = PM.normalizePositions([{ name: 'A', links: ['https://a.ru/1', 'https://b.ru/1'] }]);
  const [la, lb] = pos[0].links.map((l) => l.id);
  const now = 1e12;
  const run = { domainLast: { 'a.ru': now - 5 * PM.MIN }, domainBlockedUntil: { 'b.ru': now + PM.HOUR } };
  const r = PM.pickNext([la, lb], pos, run, { domainGapMin: 30 }, now);
  eq(r.waitUntil, now + 25 * PM.MIN, 'ждём, пока у a.ru пройдёт 30 мин');
  eq(PM.pickNext([la, lb], pos, { domainLast: {}, domainBlockedUntil: { 'a.ru': now + 1 } }, {}, now), { index: 1 });
  eq(PM.pickNext([], pos, {}, {}, now), { done: true });
});
await t('случайная пауза в диапазоне 5–10 мин', () => {
  for (let i = 0; i < 200; i++) { const d = PM.randomDelayMs({ minDelayMin: 5, maxDelayMin: 10 }); ok(d >= 5 * PM.MIN && d <= 10 * PM.MIN, String(d)); }
  eq(PM.normalizeSettings({ minDelayMin: 8, maxDelayMin: 3 }).maxDelayMin, 8, 'max не меньше min');
});
await t('импорт из Excel (TSV) и CSV с шапкой; объединение по артикулу', () => {
  const tsv = 'Товар A\t018160\t27 900\thttps://a.ru/1\nТовар A\t018160\t27900\thttps://b.ru/1\tEC-3\nТовар B\t018191\t22500\thttps://a.ru/2';
  const r = PM.importPositions(tsv, []);
  eq(r.added, 2); eq(r.links, 3);
  eq(r.positions[0].ourPrice, 27900);
  eq(r.positions[0].links[1].anchor, 'EC-3');
  const csv = '\ufeffАртикул;Наименование;Наша цена;Ссылка\n018160;Товар A;28000;https://c.ru/1\n';
  const r2 = PM.importPositions(csv, r.positions);
  eq(r2.added, 0); eq(r2.positions[0].links.length, 3); eq(r2.positions[0].ourPrice, 28000);
  const back = PM.importPositions(PM.exportPositionsCSV(r2.positions), []);
  eq(back.positions.length, 2); eq(back.positions[0].links.length, 3, 'выгрузка → загрузка без потерь');
});
await t('отчёт и CSV в формате ТЗ', () => {
  const pos = PM.normalizePositions([{ name: 'EC-3', article: '018160', ourPrice: 27900, links: [{ id: 'l1', url: 'https://www.santehtop.ru/x' }, { id: 'l2', url: 'https://santehnica.ru/y' }] }]);
  const res = { l1: { status: 'ok', price: 23715, checkedAt: 1 }, l2: { status: 'blocked', lastOkPrice: 27900, checkedAt: 2 } };
  const rows = PM.reportRows(pos, res, {});
  eq(PM.dumpLabel(rows[0]), 'santehtop.ru — Да');
  eq(PM.dumpLabel(rows[1]), 'santehnica.ru — Нет');
  ok(rows[1].stale, 'последняя известная цена помечена');
  const csv = PM.toCSV(rows);
  ok(csv.startsWith('\ufeffТовар;Артикул;Наша цена;Цена товара;Разница в цене в %;Магазин демпинг;Ссылка на магазин конкурента'), csv.slice(0, 120));
  ok(csv.indexOf('23715;-15;santehtop.ru — Да;https://www.santehtop.ru/x') > 0, csv);
});
await t('стартовый набор: 4 позиции, без исключённых доменов', () => {
  const pos = PM.normalizePositions(PM.SAMPLE_POSITIONS);
  eq(pos.length, 4);
  ok(PM.allLinks(pos).every((x) => !PM.isExcluded(x.link.url, PM.DEFAULT_SETTINGS.excludedDomains)));
  eq(pos.map((p) => p.ourPrice), [27900, 34100, 34100, 22500]);
});

/* ============================ извлечение цены ============================ */
console.log('\nextract');
await t('JSON-LD Product', () => {
  const d = page(`<html><head><title>Товар</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"Product","name":"Alto-K 018160","sku":"018160","offers":{"@type":"Offer","price":"23715.00","priceCurrency":"RUB","availability":"https://schema.org/InStock"}}]}</script></head>
    <body><h1>Comfysan Alto-K EC-3 120/12 018160</h1><div class="price">27 900 ₽</div></body></html>`);
  const r = X.extract(d, { article: '018160' });
  eq(r.price, 23715); eq(r.method, 'json-ld'); eq(r.availability, 'В наличии'); eq(r.articleFound, true);
});
await t('эвристика: старая цена, рассрочка и «похожие товары» не мешают', () => {
  const d = page(`<body><header><span class="header-cart-price">0 ₽</span></header>
    <div class="product"><h1>Comfysan Alto-K EC-3 120/12 018160</h1>
      <div class="product-prices"><span class="price-old">27 900 ₽</span><span class="price-current">23 715 ₽</span><span class="discount">-15%</span></div>
      <div class="credit-price">от 1 976 ₽/мес</div><div class="stock">В наличии</div></div>
    <div class="similar-products"><div class="item"><span class="price">18 650 ₽</span></div></div></body>`);
  const r = X.extract(d, { article: '018160' });
  eq(r.price, 23715); eq(r.availability, 'В наличии');
});
await t('зачёркнутая цена (<del>) игнорируется', () => {
  const d = page('<body><h1>Товар</h1><div class="prices"><del class="price">34 100 ₽</del> <b class="price">28 985 ₽</b></div></body>');
  eq(X.extract(d, {}).price, 28985);
});
await t('страница-список + якорь: цена в карточке нужного товара', () => {
  const d = page(`<body><h1>Поиск</h1><div class="list">
    <div class="card"><a href="/p/alto-ec-4-018627/">Comfysan Alto EC-4 120/18, оружейная сталь, гальваника</a><div class="price">29 000 руб.</div></div>
    <div class="card"><a href="/p/alto-k-ec-4-018184/">Comfysan Alto-K EC-4 120/18, оружейная сталь, гальваника</a><div class="price">31 000 руб.</div></div>
    <div class="card"><a href="/p/alto-k-ec-4-018443/">Comfysan Alto-K EC-4 120/18, золото, гальваника</a><div class="price">31 500 руб.</div></div></div></body>`);
  eq(X.extract(d, { anchor: '018184', article: '018184' }).price, 31000, 'по артикулу в ссылке');
  eq(X.extract(d, { anchor: 'Alto-K EC-4 120/18, золото' }).price, 31500, 'по фрагменту названия');
  const miss = X.extract(d, { anchor: '999999' });
  eq(miss.price, null); eq(miss.anchorFound, false);
});
await t('«related»-блок допускается, если задан якорь (santeh-crystal)', () => {
  const d = page(`<body><h1>Alto-K EC-2 120/10 белый</h1><div class="price">18 030 ₽</div>
    <div class="related-products"><div class="product-thumb"><a>Альто-К (Alto-K) EC-3 120/12, оружейная сталь, гальвани</a><p class="price">25 800 ₽</p></div></div></body>`);
  eq(X.extract(d, { anchor: 'EC-3 120/12, оружейная сталь, гальвани' }).price, 25800);
  eq(X.extract(d, {}).price, 18030, 'без якоря берём основной товар');
});
await t('CSS-селектор, заданный вручную', () => {
  const d = page('<body><span id="pp">12 345</span><div class="price">99 999 ₽</div></body>');
  const r = X.extract(d, { selector: '#pp' });
  eq(r.price, 12345); eq(r.method, 'selector');
});
await t('капча / «превышение числа запросов» распознаются как блок (без обхода)', () => {
  const d1 = page('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>');
  ok(X.extract(d1, {}).blocked, 'cloudflare');
  const d2 = page('<body><h1>Превышение числа запросов</h1><p>Попробуйте позже</p></body>');
  ok(X.extract(d2, {}).blocked, 'san-room');
  const d3 = page('<body><h1>Товар</h1><div class="price">25 110 ₽</div><footer>protected by reCAPTCHA</footer></body>');
  const r3 = X.extract(d3, {});
  eq(r3.price, 25110); eq(r3.blocked, null, 'reCAPTCHA в форме обратной связи — не блок');
});
await t('404 и артикул не на той странице', () => {
  const d = page('<html><head><title>404 — Страница не найдена</title></head><body>Ошибка</body></html>');
  ok(X.extract(d, {}).notFound);
  const d2 = page('<body><h1>Comfysan Alto-K EC-3 120/12 018436 никель</h1><div class="price">23 715 ₽</div></body>', 'https://www.santehtop.ru/comfysan-alto-k-018436/');
  const r2 = X.extract(d2, { article: '018160' });
  eq(r2.price, 23715); eq(r2.articleFound, false, 'та самая ошибка из скриншота: 018436 вместо 018160');
});
await t('микроразметка itemprop=price', () => {
  const d = page('<body><div itemscope itemtype="http://schema.org/Product"><h1 itemprop="name">X</h1><div itemprop="offers" itemscope itemtype="http://schema.org/Offer"><meta itemprop="price" content="22500"><link itemprop="availability" href="http://schema.org/OutOfStock"></div></div></body>');
  const r = X.extract(d, {});
  eq(r.price, 22500); eq(r.method, 'microdata'); eq(r.availability, 'Нет в наличии');
});

/* ============================ service worker на имитации chrome.* ============================ */
console.log('\nbackground (имитация chrome.*)');

function makeChrome(pages) {
  const store = {};
  const alarms = {};
  const listeners = { alarm: [], updated: [], message: [], installed: [], startup: [], storage: [] };
  let tabSeq = 1;
  const tabs = {}, opened = [];
  const ev = (k) => ({ addListener: (f) => listeners[k].push(f), removeListener: (f) => { listeners[k] = listeners[k].filter((x) => x !== f); } });
  const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const chrome = {
    _store: store, _alarms: alarms, _opened: opened, _tabs: tabs, _listeners: listeners, granted: new Set(),
    storage: { local: {
      get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = clone(store[k]); }); return o; },
      set: async (obj) => { Object.assign(store, clone(obj)); },
      remove: async (k) => { delete store[k]; }
    }, onChanged: ev('storage') },
    alarms: {
      create: async (name, info) => { alarms[name] = Object.assign({ name }, info); },
      clear: async (name) => { const had = name in alarms; delete alarms[name]; return had; },
      get: async (name) => alarms[name],
      onAlarm: ev('alarm')
    },
    runtime: { onStartup: ev('startup'), onInstalled: ev('installed'), onMessage: ev('message'), getPlatformInfo: async () => ({}), getURL: (p) => 'chrome-extension://x/' + p },
    permissions: { contains: async ({ origins }) => origins.every((o) => chrome.granted.has(o)) },
    windows: {
      create: async ({ url }) => { const id = tabSeq++; tabs[id] = { id, url, status: 'loading' }; opened.push(url); setTimeout(() => { tabs[id].status = 'complete'; listeners.updated.forEach((f) => f(id, { status: 'complete' })); }, 5); return { id: 1000 + id, tabs: [{ id }] }; },
      remove: async (wid) => { delete tabs[wid - 1000]; }
    },
    tabs: {
      create: async ({ url }) => { const id = tabSeq++; tabs[id] = { id, url, status: 'complete' }; opened.push(url); return { id }; },
      remove: async (id) => { delete tabs[id]; },
      update: async () => ({}),
      get: async (id) => { if (!tabs[id]) throw new Error('No tab'); return tabs[id]; },
      onUpdated: ev('updated')
    },
    scripting: {
      executeScript: async ({ target, files, func, args }) => {
        if (files) return [{}];
        const url = tabs[target.tabId].url;
        const html = pages[url];
        if (html instanceof Error) throw html;
        const doc = page(html || '<body></body>', url);
        return [{ result: X.extract(doc, args[0]) }];
      }
    },
    action: { setBadgeText: async (o) => { chrome._badge = o.text; }, setBadgeBackgroundColor: async () => { }, setTitle: async () => { } },
    notifications: { create: (id, o) => { (chrome._notes = chrome._notes || []).push(o); }, onClicked: ev('storage') }
  };
  return chrome;
}

async function bootWorker(chrome, timeScale) {
  // ускоряем ожидания внутри воркера (рендер, повторные попытки) в 1000 раз
  const fastTimeout = (fn, ms, ...a) => setTimeout(fn, Math.min(ms, 50), ...a);
  const ctx = {
    chrome, console, URL, Promise, Math, JSON, Date, Object, Array, String, Number, setInterval, clearInterval, clearTimeout,
    setTimeout: timeScale ? fastTimeout : setTimeout
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f }));
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  await new Promise((r) => setTimeout(r, 30));
  return ctx;
}
const fire = async (chrome, name) => { for (const f of chrome._listeners.alarm) await f({ name }); await new Promise((r) => setTimeout(r, 400)); };
const msg = (chrome, m) => new Promise((resolve) => { chrome._listeners.message[0](m, {}, resolve); });

await t('полный круг: по одной ссылке, пауза 5–10 мин, блок сайта → пауза и перенос', async () => {
  const prod = (price, art) => `<body><h1>Comfysan ${art}</h1><div class="price">${price} ₽</div></body>`;
  const pages = {
    'https://a.ru/1': prod('23 715', '018160'),
    'https://b.ru/1': '<html><head><title>Превышение числа запросов</title></head><body>Слишком много запросов</body></html>',
    'https://b.ru/2': prod('20 000', '018191'),
    'https://c.ru/1': prod('27 900', '018160'),
    'https://a.ru/2': prod('22 500', '018191')
  };
  const chrome = makeChrome(pages);
  await bootWorker(chrome, true);
  for (const f of chrome._listeners.installed) await f({ reason: 'update' });
  await chrome.storage.local.set({
    settings: PM.normalizeSettings({ minDelayMin: 5, maxDelayMin: 10, domainGapMin: 0, repeatHours: 24, renderWaitMinSec: 0, renderWaitMaxSec: 0 }),
    positions: PM.normalizePositions([
      { name: 'EC-3', article: '018160', ourPrice: 27900, links: [{ id: 'a1', url: 'https://a.ru/1' }, { id: 'b1', url: 'https://b.ru/1' }, { id: 'c1', url: 'https://c.ru/1' }, { id: 'x1', url: 'https://comfysan.ru/1' }] },
      { name: 'Stella', article: '018191', ourPrice: 22500, links: [{ id: 'a2', url: 'https://a.ru/2' }, { id: 'b2', url: 'https://b.ru/2' }] }
    ])
  });
  ['a.ru', 'b.ru', 'c.ru'].forEach((s) => chrome.granted.add('*://*.' + s + '/*'));

  const t0 = Date.now();
  const r = await msg(chrome, { type: 'start' });
  ok(r.ok, JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 400));
  let run = chrome._store.run;
  eq(chrome._opened.length, 1, 'сразу после старта открыта ровно одна страница');
  ok(chrome._store.log.some((e) => /В очереди 5 ссылок/.test(e.msg)), 'в очереди 5 ссылок — comfysan.ru исключён');
  const delay = run.nextAt - Date.now();
  ok(delay >= 5 * PM.MIN - 2000 && delay <= 10 * PM.MIN, 'следующая проверка через 5–10 мин, а не сразу: ' + delay);
  ok(chrome._alarms['pm-tick'], 'будильник поставлен');

  for (let i = 0; i < 8 && chrome._store.run.state === 'running'; i++) await fire(chrome, 'pm-tick');
  run = chrome._store.run;
  const res = chrome._store.results;
  eq(run.state, 'waiting', 'круг завершён, ждём следующий');
  ok(chrome._alarms['pm-cycle'] && chrome._alarms['pm-cycle'].when >= t0 + 24 * PM.HOUR - 5000, 'следующий круг через 24 ч');
  eq(res.a1.price, 23715); eq(res.a1.status, 'ok');
  eq(res.c1.price, 27900);
  eq(res.a2.price, 22500);
  eq(res.b1.status, 'blocked');
  ok(chrome._opened.indexOf('https://comfysan.ru/1') < 0, 'исключённый домен не открывали');
  // b.ru заблокировал: если b1 был раньше b2 — b2 перенесён и не открывался
  const iB1 = chrome._opened.indexOf('https://b.ru/1'), iB2 = chrome._opened.indexOf('https://b.ru/2');
  ok(iB2 < 0 || iB2 < iB1, 'после блокировки сайт больше не трогаем в этом круге');
  ok(run.domainBlockedUntil['b.ru'] > Date.now() + 5 * PM.HOUR, 'пауза по сайту ~6 ч');
  const dumping = Object.values(res).filter((x) => x.status === 'ok' && x.price < 27900 && x.price !== 22500).length;
  eq(chrome._badge, String(dumping), 'бейдж = число ссылок с демпингом');
  ok(chrome._notes.some((n) => /Демпинг: a\.ru/.test(n.title)), 'уведомление о демпинге');
  ok(Object.keys(chrome._tabs).length === 0, 'все открытые окна закрыты');
  // следующий круг: b.ru ещё на паузе → его ссылки ждут, остальные идут
  const bBefore = chrome._opened.filter((u) => u.startsWith('https://b.ru')).length;
  for (const f of chrome._listeners.alarm) await f({ name: 'pm-cycle' });
  for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 200)); if (chrome._store.run.state !== 'running') break; for (const f of chrome._listeners.alarm) await f({ name: 'pm-tick' }); }
  eq(chrome._opened.filter((u) => u.startsWith('https://b.ru')).length, bBefore, 'b.ru на паузе — в новом круге не открываем');
  ok(chrome._opened.length > 4, 'остальные сайты в новом круге проверены');
});

await t('нет разрешения на сайт → статус noaccess, страница не открывается', async () => {
  const chrome = makeChrome({});
  await bootWorker(chrome, true);
  await chrome.storage.local.set({ positions: PM.normalizePositions([{ name: 'A', article: '1', ourPrice: 100, links: [{ id: 'z', url: 'https://z.ru/1' }] }]) });
  const r = await msg(chrome, { type: 'checkNow', linkId: 'z' });
  eq(r.rec.status, 'noaccess'); eq(chrome._opened.length, 0);
});

await t('пауза/продолжить/стоп', async () => {
  const chrome = makeChrome({ 'https://a.ru/1': '<body><div class="price">100 ₽</div></body>', 'https://b.ru/1': '<body><div class="price">90 ₽</div></body>' });
  await bootWorker(chrome, true);
  chrome.granted.add('*://*.a.ru/*'); chrome.granted.add('*://*.b.ru/*');
  await chrome.storage.local.set({ settings: PM.normalizeSettings({ renderWaitMinSec: 0, renderWaitMaxSec: 0 }), positions: PM.normalizePositions([{ name: 'A', article: '1', ourPrice: 100, links: ['https://a.ru/1', 'https://b.ru/1'] }]) });
  await msg(chrome, { type: 'start' });
  await new Promise((res) => setTimeout(res, 400));
  eq((await msg(chrome, { type: 'pause' })).ok, true);
  eq(chrome._store.run.state, 'paused'); ok(!chrome._alarms['pm-tick'], 'будильник снят');
  await fire(chrome, 'pm-tick');
  eq(chrome._opened.length, 1, 'на паузе ничего не открывается');
  await msg(chrome, { type: 'resume' });
  eq(chrome._store.run.state, 'running');
  eq(chrome._opened.length, 1, 'после «Продолжить» не открываем сразу');
  ok(chrome._store.run.nextAt - Date.now() >= 4 * PM.MIN, 'ждём интервал от последней проверки');
  await msg(chrome, { type: 'stop' });
  eq(chrome._store.run.state, 'idle'); eq(chrome._store.run.queue.length, 0);
});


/* ============================ XML-фид каталога ============================ */
console.log('\nfeed');
const FEED_BYTES = fs.readFileSync(path.join(here, 'fixtures', 'feed-yml-cp1251.xml'));
await t('фид YML в windows-1251: товары, артикулы, цены, категории', () => {
  const text = PM.decodeXmlBytes(FEED_BYTES);
  ok(text.includes('Полотенцесушитель'), 'кодировка из <?xml encoding?>');
  const f = PM.parseFeed(text);
  eq([f.format, f.shop, f.categories, f.offers.length], ['yml', 'SanComfGroup', 4, 7]);
  const by = Object.fromEntries(f.offers.map((o) => [o.id, o]));
  eq([by['5001'].article, by['5001'].price, by['5001'].category], ['018160', 27900, 'Полотенцесушители / Электрические'], 'vendorCode');
  eq(by['5002'].article, '018184', '<param name="Артикул">');
  ok(by['5002'].name.startsWith('Полотенцесушитель электрический Comfysan Alto-K EC-4'), 'CDATA');
  eq([by['5003'].article, by['5003'].price, by['5003'].oldPrice], ['018443', 32000, 34100], '6 цифр в названии + oldprice');
  eq([by['5004'].price, by['5004'].available], [22500, false]);
  eq(by['5005'].name, 'Полотенцесушитель водяной Comfysan "Лесенка" П6 50x80, белый', '&quot;');
  eq(by['5005'].url, 'https://sancomfgroup.ru/catalog/vodyanye/lesenka-klassik-50-80/?a=1&b=2', '&amp;');
});
await t('фид Google Merchant RSS', () => {
  const f = PM.parseFeed(`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><title>Shop</title>
    <item><g:id>A1</g:id><title>Comfysan Alto-K EC-3 120/12 gunmetal</title><link>https://s.ru/a1</link><g:price>27900.00 RUB</g:price>
    <g:availability>in stock</g:availability><g:mpn>018160</g:mpn><g:brand>Comfysan</g:brand></item></channel></rss>`);
  eq(f.format, 'rss');
  eq([f.offers[0].article, f.offers[0].price, f.offers[0].available, f.offers[0].vendor, f.offers[0].url], ['018160', 27900, true, 'Comfysan', 'https://s.ru/a1']);
});
await t('серия из названия и шаблоны ссылок', () => {
  eq(PM.seriesOf('Полотенцесушитель электрический Comfysan Alto-K EC-4 120/18, золото', 'Comfysan'), 'alto-k');
  eq(PM.seriesOf('Comfysan Альто-К (Alto-K) EC-3 120/12', 'Comfysan'), 'alto-k');
  eq(PM.seriesOf('Полотенцесушитель Comfysan Стелла EC-6 70/40', 'Comfysan'), 'stella');
  eq(PM.seriesOf('Крючок настенный', 'Comfysan'), '');
  eq(PM.parseTemplates('https://a.ru/{article}\n# https://off.ru/{article}\nмусор\nhttps://b.ru/s?q={article} | {article}'),
    [{ url: 'https://a.ru/{article}', anchor: '' }, { url: 'https://b.ru/s?q={article}', anchor: '{article}' }]);
  const f = PM.parseFeed(PM.decodeXmlBytes(FEED_BYTES));
  const ps = PM.positionsFromFeed(f.offers, { filter: 'электрические -ЭК' });
  eq(ps.map((p) => p.article), ['018160', '018184', '018443', '018191'], 'фильтр по категории и исключение');
  eq(ps[0].links.map((l) => [l.url, l.anchor]), [['https://www.santehtop.ru/comfysan-alto-k-018160/', ''], ['https://santehpremium.ru/search/?q=018160', '018160']]);
  eq(ps[3].links[0].url, 'https://www.santehtop.ru/comfysan-stella-018191/', 'кириллическая серия → транслит');
  eq(PM.positionsFromFeed(f.offers, { onlyAvailable: true, filter: 'электрические -ЭК' }).length, 3, 'только в наличии');
  eq(PM.positionsFromFeed(f.offers, { limit: 2 }).length, 2);
  eq(PM.positionsFromFeed(f.offers, { filter: '018443', priceField: 'oldprice' })[0].ourPrice, 34100);
  const hook = PM.positionsFromFeed(f.offers, { filter: 'крючок' })[0];
  eq(hook.links.length, 1, 'без серии santehtop-шаблон не строится, поиск — да');
});
await t('слияние с текущим списком: цена из фида, ручные ссылки целы, без дублей сайтов', () => {
  const f = PM.parseFeed(PM.decodeXmlBytes(FEED_BYTES));
  const cur = PM.normalizePositions(PM.SAMPLE_POSITIONS);
  const m = PM.mergePositions(cur, PM.positionsFromFeed(f.offers, {}));
  eq([m.added, m.updated], [3, 1]);
  const gold = m.positions.find((p) => p.article === '018443');
  eq(gold.ourPrice, 32000, 'цена обновлена из фида');
  eq(gold.links.length, 4, 'santehtop и santehpremium уже были — шаблонные ссылки не добавлены');
  const st = m.positions.find((p) => p.article === '018191');
  eq(st.links.map((l) => PM.hostOf(l.url)), ['santehtop.ru', 'santehnica.ru', 'santehpremium.ru'], 'добавлен только новый сайт');
  eq(cur.find((p) => p.article === '018443').ourPrice, 34100, 'исходный список не мутируется');
  eq(PM.mergePositions(cur, PM.positionsFromFeed(f.offers, {}), true).positions.length, 7, 'режим «заменить»');
});
await t('панель: окно «Импорт из XML-фида» (jsdom + имитация chrome.*)', async () => {
  const html = fs.readFileSync(path.join(root, 'dashboard/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://x/dashboard/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const store = { settings: {}, positions: PM.normalizePositions(PM.SAMPLE_POSITIONS), results: {}, run: { state: 'idle', queue: [] }, log: [] };
  const asked = [];
  w.chrome = {
    runtime: { sendMessage: async () => ({ ok: true }) },
    storage: {
      local: {
        get: async (k) => { const ks = Array.isArray(k) ? k : [k]; return Object.fromEntries(ks.filter((x) => x in store).map((x) => [x, JSON.parse(JSON.stringify(store[x]))])); },
        set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
      },
      onChanged: { addListener() {} }
    },
    permissions: { request: async (p) => { asked.push(...p.origins); return true; }, contains: async () => true }
  };
  w.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => FEED_BYTES.buffer.slice(FEED_BYTES.byteOffset, FEED_BYTES.byteOffset + FEED_BYTES.length) });
  w.TextDecoder = TextDecoder;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function (v) { this.open = false; this.returnValue = v || ''; this.dispatchEvent(new w.Event('close')); };
  w.confirm = () => true;
  w.eval(fs.readFileSync(path.join(root, 'lib/core.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'dashboard/dashboard.js'), 'utf8'));
  const d = w.document, tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();
  d.querySelector('#btnFeed').click(); await tick();
  ok(d.querySelector('#feedDlg').open, 'окно открылось');
  eq(d.querySelector('#feedUrl').value, 'https://sancomfgroup.ru/bitrix/catalog_export/cmfsn_2CFg.xml', 'ссылка по умолчанию');
  ok(d.querySelector('#feedTpl').value.includes('{series}'), 'шаблоны по умолчанию');
  ok(d.querySelector('#feedGo').disabled, 'до загрузки импорт недоступен');
  d.querySelector('#feedLoad').click(); await tick(); await tick();
  eq(asked, ['https://sancomfgroup.ru/*'], 'доступ запрошен только к сайту фида');
  ok(/товаров <b>7<\/b>/.test(d.querySelector('#feedInfo').innerHTML), d.querySelector('#feedInfo').textContent);
  eq(d.querySelectorAll('#feedPreview tbody tr').length, 7);
  const f = d.querySelector('#feedFilter'); f.value = 'электрические -ЭК'; f.dispatchEvent(new w.Event('input'));
  eq(d.querySelectorAll('#feedPreview tbody tr').length, 4, 'предпросмотр следует за фильтром');
  ok(/обновится цен 1/.test(d.querySelector('#feedInfo').textContent), d.querySelector('#feedInfo').textContent);
  d.querySelector('#feedDlg').close('ok'); await tick();
  eq(store.feedCfg.filter, 'электрические -ЭК', 'настройки окна запомнены');
  ok(!d.querySelector('#dirty').hidden, 'изменения ждут «Сохранить»');
  d.querySelector('#btnSavePos').click(); await tick();
  eq(store.positions.length, 4);
  eq(store.positions.find((p) => p.article === '018443').ourPrice, 32000);
  eq(store.positions.find((p) => p.article === '018191').links.length, 3);
  w.close();   // у панели setInterval — иначе node не завершится
});

/* ============================ манифест и файлы ============================ */
console.log('\nmanifest');
await t('манифест MV3: файлы на месте, без широких host_permissions', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  eq(m.manifest_version, 3);
  ok(!m.host_permissions, 'доступ к сайтам — только по запросу (optional_host_permissions)');
  [m.background.service_worker, m.action.default_popup, 'dashboard/index.html', 'lib/core.js', 'lib/extract.js', ...Object.values(m.icons)]
    .forEach((f) => ok(fs.existsSync(path.join(root, f)), 'нет файла ' + f));
  for (const p of ['permissions']) ok(m[p].includes('alarms') && m[p].includes('scripting'));
});
await t('страницы панели и попапа ссылаются на существующие скрипты', () => {
  for (const html of ['dashboard/index.html', 'popup/popup.html']) {
    const src = fs.readFileSync(path.join(root, html), 'utf8');
    for (const m of src.matchAll(/(?:src|href)="(\.\.\/[^"]+|[\w-]+\.(?:js|css))"/g)) ok(fs.existsSync(path.join(root, path.dirname(html), m[1])), html + ': ' + m[1]);
    ok(!/<script>[^<]/.test(src), 'инлайн-скрипты запрещены CSP');
  }
});

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) { console.log(fails.map((f) => ' - ' + f).join('\n')); process.exit(1); }
