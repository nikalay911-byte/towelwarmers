/*
 * «Монитор цен конкурентов» — чистая логика без chrome.* (тестируется в node).
 * Расписание очереди, разбор цен, расчёт отклонения, импорт/экспорт таблиц.
 * Подключается в service worker (importScripts), в страницы (<script>) и в node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PM = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MIN = 60 * 1000, HOUR = 60 * MIN;

  /* ---------------- настройки по умолчанию ---------------- */
  var DEFAULT_SETTINGS = {
    minDelayMin: 5,          // пауза между проверками — случайная в диапазоне [min; max] минут
    maxDelayMin: 10,
    domainGapMin: 30,        // один и тот же сайт — не чаще, чем раз в N минут
    repeatHours: 24,         // новый круг через N часов после старта предыдущего (0 — не повторять)
    openMode: 'window',      // 'window' — свёрнутое окно, 'tab' — фоновая вкладка
    pageTimeoutSec: 45,      // ждём загрузку страницы не дольше
    renderWaitMinSec: 3,     // после загрузки ждём отрисовку цены (JS-сайты)
    renderWaitMaxSec: 7,
    blockBackoffHours: 6,    // сайт показал капчу/блок → пауза по сайту, при повторе удваивается
    dumpThresholdPct: 0,     // «демпинг», если цена ниже нашей больше чем на N %
    notify: true,
    excludedDomains: ['comfysan.ru', 'comfysan-shop.ru', 'polotenhik.ru', 'sancomfgroup.ru', 'sancomf.ru']
  };

  function normalizeSettings(s) {
    var o = Object.assign({}, DEFAULT_SETTINGS, s || {});
    var num = function (v, d, lo, hi) { v = Number(v); if (!isFinite(v)) v = d; return Math.min(hi, Math.max(lo, v)); };
    o.minDelayMin = num(o.minDelayMin, 5, 1, 24 * 60);
    o.maxDelayMin = num(o.maxDelayMin, 10, o.minDelayMin, 24 * 60);
    o.domainGapMin = num(o.domainGapMin, 30, 0, 7 * 24 * 60);
    o.repeatHours = num(o.repeatHours, 24, 0, 24 * 30);
    o.pageTimeoutSec = num(o.pageTimeoutSec, 45, 10, 180);
    o.renderWaitMinSec = num(o.renderWaitMinSec, 3, 0, 60);
    o.renderWaitMaxSec = num(o.renderWaitMaxSec, 7, o.renderWaitMinSec, 120);
    o.blockBackoffHours = num(o.blockBackoffHours, 6, 1, 24 * 7);
    o.dumpThresholdPct = num(o.dumpThresholdPct, 0, 0, 100);
    o.openMode = o.openMode === 'tab' ? 'tab' : 'window';
    o.notify = !!o.notify;
    if (typeof o.excludedDomains === 'string') o.excludedDomains = o.excludedDomains.split(/[\s,;]+/);
    o.excludedDomains = (o.excludedDomains || []).map(function (d) { return hostOf(d) || String(d).trim().toLowerCase(); }).filter(Boolean);
    return o;
  }

  /* ---------------- домены ---------------- */
  function hostOf(url) {
    var s = String(url || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try { return new URL(s).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
  }
  /** «Сайт» для паузы и разнесения: msk.santehnica.ru и santehnica.ru — один сайт. */
  function siteOf(url) {
    var h = hostOf(url);
    if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
    var p = h.split('.');
    if (p.length <= 2) return h;
    var sld = p[p.length - 2];
    var n = (/^(com|net|org|co|gov|edu|msk|spb)$/.test(sld) && p[p.length - 1].length === 2) ? 3 : 2;
    return p.slice(-n).join('.');
  }
  function isExcluded(url, excluded) {
    var h = hostOf(url);
    if (!h) return false;
    return (excluded || []).some(function (d) { return h === d || h.slice(-(d.length + 1)) === '.' + d; });
  }
  /** Шаблоны для chrome.permissions: *://*.site/* покрывает и сам site, и поддомены. */
  function originPatterns(urls) {
    var set = {};
    (urls || []).forEach(function (u) { var s = siteOf(u); if (s) set['*://*.' + s + '/*'] = 1; });
    return Object.keys(set).sort();
  }

  /* ---------------- цены ---------------- */
  var PRICE_RE = /(\d{1,3}(?:[ \u00a0\u2009\u202f'](?=\d{3})\d{3})+|\d+)(?:[.,](\d{1,2}))?(?!\d)/g;
  /** Первая правдоподобная цена из текста: «23 715 ₽», «23&nbsp;715 руб.», «23715.00», «от 1 999,90». */
  function parsePrice(text, opts) {
    if (typeof text === 'number') return isFinite(text) && text > 0 ? text : null;
    var s = String(text == null ? '' : text);
    var lo = (opts && opts.min) || 50, hi = (opts && opts.max) || 50000000;
    PRICE_RE.lastIndex = 0;
    var m;
    while ((m = PRICE_RE.exec(s))) {
      var v = Number(m[1].replace(/[^\d]/g, '') + (m[2] ? '.' + m[2] : ''));
      // «-15%» и т. п. — не цена
      var after = s.slice(m.index + m[0].length, m.index + m[0].length + 3);
      if (/^\s*%/.test(after)) continue;
      if (v >= lo && v <= hi) return Math.round(v * 100) / 100;
    }
    return null;
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  /** ((конкурент − наша) / наша) × 100, 2 знака. */
  function deviation(competitor, ours) {
    competitor = Number(competitor); ours = Number(ours);
    if (!(ours > 0) || !(competitor > 0)) return null;
    return round2((competitor - ours) / ours * 100);
  }
  function isDumping(competitor, ours, thresholdPct) {
    var d = deviation(competitor, ours);
    if (d === null) return null;
    return d < -(Number(thresholdPct) || 0) - 1e-9;
  }
  function fmtMoney(v) {
    if (v == null || !isFinite(v)) return '—';
    var s = (Math.round(v * 100) / 100).toFixed(v % 1 ? 2 : 0).replace('.', ',');
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + '\u00a0₽';
  }
  function fmtPct(d) {
    if (d == null || !isFinite(d)) return '—';
    return (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(2).replace('.', ',') + '%';
  }

  /* ---------------- позиции ---------------- */
  var _seq = 0;
  function uid(prefix) {
    _seq = (_seq + 1) % 1e6;
    return (prefix || 'id') + Date.now().toString(36) + _seq.toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function normalizePositions(list) {
    return (Array.isArray(list) ? list : []).map(function (p) {
      var links = (p.links || []).map(function (l) {
        if (typeof l === 'string') l = { url: l };
        return {
          id: l.id || uid('l'),
          url: String(l.url || '').trim(),
          anchor: String(l.anchor || '').trim(),
          selector: String(l.selector || '').trim(),
          enabled: l.enabled !== false
        };
      }).filter(function (l) { return /^https?:\/\//i.test(l.url); });
      return {
        id: p.id || uid('p'),
        name: String(p.name || '').trim(),
        article: String(p.article || '').trim(),
        ourPrice: parsePrice(p.ourPrice) || 0,
        links: links
      };
    }).filter(function (p) { return p.name || p.article || p.links.length; });
  }
  function allLinks(positions) {
    var out = [];
    (positions || []).forEach(function (p) { (p.links || []).forEach(function (l) { out.push({ pos: p, link: l }); }); });
    return out;
  }
  function findLink(positions, linkId) {
    var all = allLinks(positions);
    for (var i = 0; i < all.length; i++) if (all[i].link.id === linkId) return all[i];
    return null;
  }

  /* ---------------- очередь и расписание ---------------- */
  function shuffle(arr, rnd) {
    rnd = rnd || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  /**
   * Очередь на круг: все включённые ссылки, кроме исключённых доменов, вперемешку
   * и «по кругу» между сайтами — подряд на один и тот же сайт не ходим.
   */
  function buildQueue(positions, settings, rnd) {
    var st = normalizeSettings(settings);
    var bySite = {}, order = [];
    shuffle(allLinks(positions), rnd).forEach(function (x) {
      if (!x.link.enabled || isExcluded(x.link.url, st.excludedDomains)) return;
      var s = siteOf(x.link.url);
      if (!bySite[s]) { bySite[s] = []; order.push(s); }
      bySite[s].push(x.link.id);
    });
    // начинаем с самых «длинных» сайтов, чтобы хвост не состоял из одного сайта подряд
    order.sort(function (a, b) { return bySite[b].length - bySite[a].length; });
    var q = [], more = true;
    while (more) {
      more = false;
      for (var i = 0; i < order.length; i++) {
        var id = bySite[order[i]].shift();
        if (id) { q.push(id); more = true; }
      }
    }
    return q;
  }
  function randomDelayMs(settings, rnd) {
    var st = normalizeSettings(settings);
    var r = (rnd || Math.random)();
    return Math.round((st.minDelayMin + (st.maxDelayMin - st.minDelayMin) * r) * MIN);
  }
  /**
   * Какую ссылку проверять следующей. Пропускаем сайты на паузе (блок) и сайты,
   * которые проверяли меньше domainGap назад. Возвращает {index} или {waitUntil}.
   */
  function pickNext(queue, positions, run, settings, now) {
    var st = normalizeSettings(settings);
    var gap = st.domainGapMin * MIN, earliest = Infinity;
    var last = (run && run.domainLast) || {}, blocked = (run && run.domainBlockedUntil) || {};
    for (var i = 0; i < queue.length; i++) {
      var x = findLink(positions, queue[i]);
      if (!x) return { index: i, missing: true };
      var s = siteOf(x.link.url);
      var t = Math.max(blocked[s] || 0, (last[s] || 0) + gap);
      if (t <= now) return { index: i };
      earliest = Math.min(earliest, t);
    }
    return queue.length ? { waitUntil: earliest } : { done: true };
  }
  function estimateCycleMs(count, settings) {
    var st = normalizeSettings(settings);
    return Math.max(0, count - 1) * (st.minDelayMin + st.maxDelayMin) / 2 * MIN;
  }
  function fmtDuration(ms) {
    if (!(ms > 0)) return '0 мин';
    var m = Math.round(ms / MIN), h = Math.floor(m / 60);
    m = m % 60;
    if (h >= 24) { var d = Math.floor(h / 24); h = h % 24; return d + ' д ' + (h ? h + ' ч' : ''); }
    return (h ? h + ' ч ' : '') + (m || !h ? m + ' мин' : '');
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    return (sameDay ? '' : p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ') + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------------- результаты ---------------- */
  var STATUS = {
    ok: 'OK', noprice: 'Цена не найдена', blocked: 'Сайт ограничил доступ', error: 'Ошибка',
    notfound: 'Страница не найдена', skipped: 'Пропущено', noaccess: 'Нет доступа к сайту'
  };
  /** Строки отчёта в формате ТЗ: Цена товара | Разница в % | Магазин демпинг | Ссылка. */
  function reportRows(positions, results, settings) {
    var st = normalizeSettings(settings);
    var rows = [];
    (positions || []).forEach(function (p) {
      (p.links || []).forEach(function (l) {
        var r = (results || {})[l.id] || {};
        var price = r.status === 'ok' ? r.price : (r.lastOkPrice || null);
        var dev = deviation(price, p.ourPrice);
        var dump = isDumping(price, p.ourPrice, st.dumpThresholdPct);
        rows.push({
          posId: p.id, linkId: l.id, name: p.name, article: p.article, ourPrice: p.ourPrice,
          store: hostOf(l.url), url: r.finalUrl || l.url, price: price, deviation: dev, dumping: dump,
          stale: r.status !== 'ok' && price != null, status: r.status || 'new', statusText: r.status ? (STATUS[r.status] || r.status) : 'Ещё не проверялось',
          error: r.error || '', checkedAt: r.checkedAt || 0, articleFound: r.articleFound, availability: r.availability || '',
          excluded: isExcluded(l.url, st.excludedDomains), enabled: l.enabled !== false
        });
      });
    });
    return rows;
  }
  function dumpLabel(row) {
    if (row.dumping == null) return row.store + ' — н/д';
    return row.store + ' — ' + (row.dumping ? 'Да' : 'Нет');
  }

  /* ---------------- CSV ---------------- */
  function csvCell(v, sep) {
    var s = v == null ? '' : String(v);
    return (s.indexOf(sep) >= 0 || /["\r\n]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** CSV для Excel (BOM + «;», десятичная запятая). */
  function toCSV(rows, sep) {
    sep = sep || ';';
    var head = ['Товар', 'Артикул', 'Наша цена', 'Цена товара', 'Разница в цене в %', 'Магазин демпинг', 'Ссылка на магазин конкурента', 'Наличие', 'Статус', 'Проверено'];
    var lines = [head.map(function (h) { return csvCell(h, sep); }).join(sep)];
    rows.forEach(function (r) {
      lines.push([
        r.name, r.article, r.ourPrice || '', r.price == null ? '' : r.price,
        r.deviation == null ? '' : String(r.deviation).replace('.', ','),
        dumpLabel(r), r.url, r.availability || '',
        r.statusText + (r.stale ? ' (последняя известная цена)' : '') + (r.articleFound === false ? ' · артикул не найден на странице' : ''),
        r.checkedAt ? new Date(r.checkedAt).toLocaleString('ru-RU') : ''
      ].map(function (c) { return csvCell(c, sep); }).join(sep));
    });
    return '\ufeff' + lines.join('\r\n');
  }
  /** Разбор CSV/TSV (в т. ч. вставки из Excel): кавычки, переносы внутри кавычек. */
  function parseDelimited(text) {
    text = String(text || '').replace(/^\ufeff/, '');
    var firstLine = text.split(/\r?\n/)[0] || '';
    var sep = firstLine.indexOf('\t') >= 0 ? '\t' : (firstLine.split(';').length >= firstLine.split(',').length ? ';' : ',');
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(function (r) { return r.map(function (x) { return x.trim(); }); })
      .filter(function (r) { return r.some(Boolean); });
  }
  /**
   * Импорт позиций. Колонки: Наименование | Артикул | Наша цена | Ссылка [| Якорь] [| CSS-селектор].
   * Шапка необязательна (узнаётся по словам). Строки с одинаковым артикулом (или названием) — одна позиция.
   */
  function importPositions(text, existing) {
    var rows = parseDelimited(text);
    if (!rows.length) return { positions: existing || [], added: 0, links: 0 };
    var idx = { name: 0, article: 1, price: 2, url: 3, anchor: 4, selector: 5 };
    var h = rows[0].map(function (x) { return x.toLowerCase(); });
    // шапка: есть слова-заголовки, но нет ни ссылок, ни чисел (артикул/цена)
    var isHead = h.some(function (x) { return /наимен|товар|назв|артик|ссылк|url|цен/.test(x); }) &&
      !h.some(function (x) { return /^https?:\/\//.test(x) || /^[\d\s.,₽р]+$/.test(x); });
    if (isHead) {
      var find = function (re, d) { for (var i = 0; i < h.length; i++) if (re.test(h[i])) return i; return d; };
      idx = {
        name: find(/наимен|товар|назв|name/, -1), article: find(/артик|код|sku/, -1),
        price: find(/наша|ррц|цена|price/, -1), url: find(/ссылк|url|адрес|link/, -1),
        anchor: find(/якор|anchor|текст/, -1), selector: find(/селект|selector|css/, -1)
      };
      rows = rows.slice(1);
    }
    var list = normalizePositions(existing || []);
    var key = function (p) { return (p.article || p.name).toLowerCase(); };
    var map = {};
    list.forEach(function (p) { map[key(p)] = p; });
    var added = 0, links = 0;
    rows.forEach(function (r) {
      var g = function (k) { return idx[k] >= 0 ? (r[idx[k]] || '') : ''; };
      var name = g('name'), article = g('article'), url = g('url');
      if (!url) { var u = r.filter(function (c) { return /^https?:\/\//i.test(c); })[0]; if (u) url = u; }
      if (!name && !article) return;
      var k = (article || name).toLowerCase();
      var p = map[k];
      if (!p) { p = { id: uid('p'), name: name, article: article, ourPrice: parsePrice(g('price')) || 0, links: [] }; map[k] = p; list.push(p); added++; }
      else {
        if (name && !p.name) p.name = name;
        var pr = parsePrice(g('price')); if (pr) p.ourPrice = pr;
      }
      if (/^https?:\/\//i.test(url) && !p.links.some(function (l) { return l.url === url && l.anchor === g('anchor'); })) {
        p.links.push({ id: uid('l'), url: url, anchor: g('anchor'), selector: g('selector'), enabled: true });
        links++;
      }
    });
    return { positions: list, added: added, links: links };
  }
  function exportPositionsCSV(positions) {
    var sep = ';';
    var lines = [['Наименование', 'Артикул', 'Наша цена', 'Ссылка', 'Якорь', 'CSS-селектор'].join(sep)];
    (positions || []).forEach(function (p) {
      var ls = p.links.length ? p.links : [{ url: '', anchor: '', selector: '' }];
      ls.forEach(function (l) {
        lines.push([p.name, p.article, p.ourPrice || '', l.url, l.anchor, l.selector].map(function (c) { return csvCell(c, sep); }).join(sep));
      });
    });
    return '\ufeff' + lines.join('\r\n');
  }


  /* ---------------- XML-фид каталога (YML / Яндекс.Маркет, Google Merchant RSS/Atom) ---------------- */
  /** Шаблоны ссылок конкурентов: «URL [| якорь]». Подстановки: {article} {series} {brand} {name}. */
  var DEFAULT_LINK_TEMPLATES = [
    'https://www.santehtop.ru/{brand}-{series}-{article}/',
    'https://santehpremium.ru/search/?q={article} | {article}'
  ];
  var DEFAULT_FEED = {
    url: 'https://sancomfgroup.ru/bitrix/catalog_export/cmfsn_2CFg.xml',
    brand: 'Comfysan', filter: '', onlyAvailable: false, limit: 0, priceField: 'price',
    templates: DEFAULT_LINK_TEMPLATES.join('\n')
  };
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
  function xmlText(s) {
    s = String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (m, c) {
      return c.replace(/&/g, '&amp;').replace(/</g, '&lt;');   // содержимое CDATA — как есть
    });
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') { var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : m; }
      var k = e.toLowerCase(); return k in ENT ? ENT[k] : m;
    });
    return s.replace(/\s+/g, ' ').trim();
  }
  function xmlAttrs(s) {
    var o = {}, re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, m;
    while ((m = re.exec(s || ''))) o[m[1].toLowerCase()] = xmlText(m[2] != null ? m[2] : m[3]);
    return o;
  }
  /** Значение первого из тегов (с любым префиксом пространства имён: g:price, price). */
  function xmlTag(block, names) {
    for (var i = 0; i < names.length; i++) {
      var re = new RegExp('<(?:[\\w-]+:)?' + names[i] + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?' + names[i] + '\\s*>', 'i');
      var m = block.match(re);
      if (m) { var v = xmlText(m[1]); if (v) return v; }
    }
    return '';
  }
  /** Байты фида → текст по кодировке из <?xml … encoding="…"?> (Bitrix часто отдаёт windows-1251). */
  function decodeXmlBytes(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var head = '';
    for (var i = 0; i < Math.min(u8.length, 300); i++) head += String.fromCharCode(u8[i]);
    var m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
    var enc = (m ? m[1] : 'utf-8').toLowerCase();
    if (/^(cp|win)-?1251$/.test(enc)) enc = 'windows-1251';
    try { return new TextDecoder(enc).decode(u8); } catch (e) { return new TextDecoder('utf-8').decode(u8); }
  }
  var ART_PARAM_RE = /^(артикул|арт\.?|код производителя|артикул производителя|vendor ?code|sku|mpn)$/i;
  /**
   * Разбор фида. → { format, shop, offers: [{ id, name, article, price, oldPrice, url, vendor, category, available, currency }] }
   * Артикул: vendorCode → <param name="Артикул"> → g:mpn / sku → 6 цифр в названии или URL → id предложения.
   */
  function parseFeed(xml) {
    xml = String(xml || '').replace(/^\ufeff/, '');
    var cats = {}, parents = {}, m;
    var catRe = /<category\b([^>]*)>([\s\S]*?)<\/category>/gi;
    while ((m = catRe.exec(xml))) { var a = xmlAttrs(m[1]); if (a.id) { cats[a.id] = xmlText(m[2]); if (a.parentid) parents[a.id] = a.parentid; } }
    var catPath = function (id) {
      var out = [], guard = 0;
      while (id && cats[id] != null && guard++ < 20) { out.unshift(cats[id]); id = parents[id]; }
      return out.join(' / ');
    };
    var format = /<yml_catalog\b/i.test(xml) || /<offer\b/i.test(xml) ? 'yml' : (/<rss\b/i.test(xml) ? 'rss' : (/<feed\b/i.test(xml) ? 'atom' : 'unknown'));
    var re = format === 'yml' ? /<offer\b([^>]*)>([\s\S]*?)<\/offer>/gi : (format === 'atom' ? /<entry\b([^>]*)>([\s\S]*?)<\/entry>/gi : /<item\b([^>]*)>([\s\S]*?)<\/item>/gi);
    var offers = [];
    while ((m = re.exec(xml))) {
      var at = xmlAttrs(m[1]), b = m[2], params = {}, pm, pre = /<param\b([^>]*)>([\s\S]*?)<\/param>/gi;
      while ((pm = pre.exec(b))) { var pa = xmlAttrs(pm[1]); if (pa.name) params[pa.name.trim()] = xmlText(pm[2]); }
      var name = xmlTag(b, ['name', 'title']);
      if (!name) name = [xmlTag(b, ['typePrefix']), xmlTag(b, ['vendor']), xmlTag(b, ['model'])].filter(Boolean).join(' ');
      var url = xmlTag(b, ['url', 'link']);
      if (!url) { var lm = b.match(/<link\b[^>]*href\s*=\s*["']([^"']+)["']/i); if (lm) url = xmlText(lm[1]); }
      var article = xmlTag(b, ['vendorCode']);
      if (!article) for (var k in params) if (ART_PARAM_RE.test(k) && params[k]) { article = params[k]; break; }
      if (!article) article = xmlTag(b, ['mpn', 'sku', 'article']);
      if (!article) { var d6 = (name.match(/(?:^|[^\d])(\d{6})(?!\d)/) || url.match(/(?:^|[^\d])(\d{6})(?!\d)/) || [])[1]; if (d6) article = d6; }
      var id = at.id || xmlTag(b, ['id']);
      if (!article) article = id || '';
      var availRaw = at.available != null ? at.available : xmlTag(b, ['availability', 'available']);
      var available = availRaw === '' ? null : /^(true|1|yes|in[ _]stock|в наличии)$/i.test(availRaw);
      var catId = xmlTag(b, ['categoryId']);
      offers.push({
        id: id, name: name, article: article,
        price: parsePrice(xmlTag(b, ['price']), { min: 1 }),
        oldPrice: parsePrice(xmlTag(b, ['oldprice', 'sale_price_old']), { min: 1 }),
        url: url, vendor: xmlTag(b, ['vendor', 'brand']),
        category: catId ? (catPath(catId) || catId) : xmlTag(b, ['product_type', 'google_product_category']),
        available: available, currency: xmlTag(b, ['currencyId', 'currency']), params: params
      });
    }
    return { format: format, shop: xmlTag(xml.slice(0, 5000), ['name', 'title']), offers: offers, categories: Object.keys(cats).length };
  }
  var TR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya' };
  function slugify(s) {
    return String(s || '').toLowerCase().split('').map(function (c) { return TR[c] != null ? TR[c] : c; }).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  /** Серия из названия: «… Comfysan Alto-K EC-4 120/18 …» → alto-k; «Comfysan Стелла EC-6» → stella. */
  function seriesOf(name, brand) {
    var s = String(name || ''), b = brand ? s.toLowerCase().indexOf(String(brand).toLowerCase()) : -1;
    var rest = b >= 0 ? s.slice(b + String(brand).length) : s;
    var lat = [], cyr = [], toks = rest.split(/[\s,;]+/);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i].replace(/^[(«"'\[]+|[)»"'.\]:]+$/g, '');
      if (!t) continue;
      if (/\d|\//.test(t)) break;                                   // EC-4, 120/18 — дальше уже модель/размер
      if (/^[a-z][a-z'-]*$/i.test(t)) { lat.push(t); continue; }
      if (lat.length) break;
      if (b >= 0 && /^[А-ЯЁ][а-яё-]*$/.test(t) && cyr.length < 2) cyr.push(t);
      else if (cyr.length) break;
    }
    return slugify((lat.length ? lat : cyr).join(' '));
  }
  function parseTemplates(text) {
    return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l && l[0] !== '#'; })
      .map(function (l) { var i = l.indexOf(' | '); return i < 0 ? { url: l, anchor: '' } : { url: l.slice(0, i).trim(), anchor: l.slice(i + 3).trim() }; })
      .filter(function (t) { return /^https?:\/\//i.test(t.url); });
  }
  function fillTemplate(tpl, v, encode) {
    var bad = false;
    var out = tpl.replace(/\{(article|series|brand|name)\}/g, function (m, k) {
      var x = v[k] || ''; if (!x) bad = true;
      return encode ? encodeURIComponent(x) : x;
    });
    return bad ? '' : out;
  }
  function matchFilter(text, filter) {
    var hay = String(text || '').toLowerCase().replace(/ё/g, 'е');
    return String(filter || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).every(function (w) {
      return w[0] === '-' ? (w.length < 2 || hay.indexOf(w.slice(1)) < 0) : hay.indexOf(w) >= 0;
    });
  }
  /** Предложения фида → позиции со ссылками по шаблонам. opts: templates, brand, filter, onlyAvailable, limit, priceField. */
  function positionsFromFeed(offers, opts) {
    var o = Object.assign({}, DEFAULT_FEED, opts || {});
    var tpls = Array.isArray(o.templates) ? o.templates : parseTemplates(o.templates);
    var seen = {}, out = [];
    (offers || []).forEach(function (f) {
      if (o.limit > 0 && out.length >= o.limit) return;
      if (o.onlyAvailable && f.available === false) return;
      if (!matchFilter(f.name + ' ' + f.category + ' ' + f.article + ' ' + f.vendor, o.filter)) return;
      var key = String(f.article || f.name).toLowerCase();
      if (!key || seen[key]) return;
      seen[key] = 1;
      var brand = f.vendor || o.brand || '';
      var v = { article: f.article, series: seriesOf(f.name, brand), brand: slugify(brand), name: f.name };
      var links = [];
      tpls.forEach(function (t) {
        var url = fillTemplate(t.url, v, true);
        if (url && !links.some(function (l) { return l.url === url; })) links.push({ url: url, anchor: t.anchor ? fillTemplate(t.anchor, v, false) : '' });
      });
      var price = o.priceField === 'oldprice' ? (f.oldPrice || f.price) : (o.priceField === 'max' ? Math.max(f.price || 0, f.oldPrice || 0) : f.price);
      out.push({ name: f.name, article: f.article, ourPrice: price || 0, links: links });
    });
    return normalizePositions(out);
  }
  /**
   * Слияние позиций из фида с текущими (по артикулу). Цена и пустое название берутся из фида; ручные ссылки остаются;
   * ссылка по шаблону не добавляется, если у позиции уже есть ссылка на этот сайт.
   */
  function mergePositions(existing, incoming, replace) {
    var list = replace ? [] : normalizePositions(existing || []);
    var key = function (p) { return String(p.article || p.name).toLowerCase(); };
    var map = {}, added = 0, updated = 0, links = 0;
    list.forEach(function (p) { map[key(p)] = p; });
    normalizePositions(incoming || []).forEach(function (n) {
      var p = map[key(n)];
      if (!p) { map[key(n)] = n; list.push(n); added++; links += n.links.length; return; }
      if (n.ourPrice && n.ourPrice !== p.ourPrice) { p.ourPrice = n.ourPrice; updated++; }
      if (!p.name) p.name = n.name;
      n.links.forEach(function (l) {
        if (p.links.some(function (x) { return x.url === l.url || siteOf(x.url) === siteOf(l.url); })) return;
        p.links.push(l); links++;
      });
    });
    return { positions: list, added: added, updated: updated, links: links };
  }

  /* ---------------- стартовый набор: позиции из отчёта ---------------- */
  var SAMPLE_POSITIONS = [
    {
      name: 'Comfysan Альто-К (Alto-K) EC-3 120/12, оружейная сталь, гальваника', article: '018160', ourPrice: 27900,
      links: [
        { url: 'https://www.santehtop.ru/comfysan-alto-k-018160/' },
        { url: 'https://santehpremium.ru/product/polotencesushitel-elektricheskiy-s-t-comfysan-alto-k-ec-3-120-15-oruzheynaya-stal-nr-018160/' },
        { url: 'https://www.santehnica.ru/product/1644811.html' },
        { url: 'https://santeh-crystal.ru/polotentsesushitel-elektricheskij-st-comfysan-alto-k-ec-2-12010-belyj-pravyj-ten', anchor: 'EC-3 120/12, оружейная сталь, гальвани' }
      ]
    },
    {
      name: 'Comfysan Альто-К (Alto-K) EC-4 120/18, оружейная сталь, гальваника', article: '018184', ourPrice: 34100,
      links: [
        { url: 'https://www.santehtop.ru/comfysan-alto-k-018184/' },
        { url: 'https://santehpremium.ru/product/polotencesushitel-elektricheskiy-s-t-comfysan-alto-k-ec-4-120-15-oruzheynaya-stal-nr-018184/' },
        { url: 'https://santeh-crystal.ru/polotentsesushitel-elektricheskij-st-comfysan-alto-k-ec-2-12010-belyj-pravyj-ten', anchor: 'EC-4 120/18, оружейная сталь, гальваника' },
        { url: 'https://www.vseinstrumenti.ru/tag-page/polotentsesushiteli-elektricheskie-vertikalnye-674912/', anchor: '018184' }
      ]
    },
    {
      name: 'Comfysan Альто-К (Alto-K) EC-4 120/18, золото, гальваника', article: '018443', ourPrice: 34100,
      links: [
        { url: 'https://www.santehtop.ru/comfysan-alto-k-018443/' },
        { url: 'https://santehpremium.ru/product/polotencesushitel-elektricheskiy-s-t-comfysan-alto-k-ec-4-120-15-zoloto-galvanika-018443/' },
        { url: 'https://santeh-crystal.ru/polotentsesushitel-elektricheskij-st-comfysan-alto-k-ec-2-12010-belyj-pravyj-ten', anchor: 'EC-4 120/18, золото, гальваника' },
        { url: 'https://www.vseinstrumenti.ru/tag-page/polotentsesushiteli-elektricheskie-vertikalnye-674912/', anchor: '018443' }
      ]
    },
    {
      name: 'Comfysan Стелла (Stella) EC-6 70/40, оружейная сталь, гальваника', article: '018191', ourPrice: 22500,
      links: [
        { url: 'https://www.santehtop.ru/comfysan-stella-018191/' },
        { url: 'https://www.santehnica.ru/product/1650561.html' }
      ]
    }
  ];

  return {
    MIN: MIN, HOUR: HOUR, DEFAULT_SETTINGS: DEFAULT_SETTINGS, STATUS: STATUS, SAMPLE_POSITIONS: SAMPLE_POSITIONS,
    normalizeSettings: normalizeSettings, hostOf: hostOf, siteOf: siteOf, isExcluded: isExcluded, originPatterns: originPatterns,
    parsePrice: parsePrice, deviation: deviation, isDumping: isDumping, fmtMoney: fmtMoney, fmtPct: fmtPct,
    uid: uid, normalizePositions: normalizePositions, allLinks: allLinks, findLink: findLink,
    shuffle: shuffle, buildQueue: buildQueue, randomDelayMs: randomDelayMs, pickNext: pickNext,
    estimateCycleMs: estimateCycleMs, fmtDuration: fmtDuration, fmtTime: fmtTime,
    reportRows: reportRows, dumpLabel: dumpLabel, toCSV: toCSV, parseDelimited: parseDelimited,
    importPositions: importPositions, exportPositionsCSV: exportPositionsCSV,
    DEFAULT_FEED: DEFAULT_FEED, DEFAULT_LINK_TEMPLATES: DEFAULT_LINK_TEMPLATES, decodeXmlBytes: decodeXmlBytes,
    parseFeed: parseFeed, slugify: slugify, seriesOf: seriesOf, parseTemplates: parseTemplates,
    positionsFromFeed: positionsFromFeed, mergePositions: mergePositions
  };
});
