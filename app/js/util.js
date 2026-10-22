/*
 * «Остатки Ника 41» — утилиты.
 * CommonJS-совместимый модуль: работает и как <script> в браузере,
 * и как require() в Node.js (для автотестов).
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.OST = root.OST || {};
  for (var k in mod) root.OST[k] = mod[k];
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SPACES = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g;
  var DASHES = /[\u2010-\u2015\u2212\uff0d\u002d]/g;
  var QUOTES = /[\u00ab\u00bb\u201c-\u201f\u2032\u2033]/g;

  /** Нормализация строки для поиска и группировки. */
  function norm(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(SPACES, ' ')
      .normalize('NFKC')
      .replace(DASHES, '-')
      .replace(QUOTES, "'")
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // клавиши, выровненные по рядам: верхний (12) + средний (11) + нижний (10) + ` / ё
  var LAYOUT_RU = 'йцукенгшщзхъ' + 'фывапролджэ' + 'ячсмитьбю.' + 'ё';
  var LAYOUT_EN = 'qwertyuiop[]' + "asdfghjkl;'" + 'zxcvbnm,/' + '`';

  /** Перевод текста в другую раскладку (RU<->EN) — на случай забытой смены языка. */
  function swapLayout(s) {
    var from, to;
    if (/[а-яА-ЯёЁ]/.test(s)) { from = LAYOUT_RU; to = LAYOUT_EN; }
    else if (/[a-z]/.test(s)) { from = LAYOUT_EN; to = LAYOUT_RU; }
    else return '';
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i].toLowerCase();
      var idx = from.indexOf(ch);
      out += idx >= 0 ? (s[i] === s[i].toUpperCase() && /[a-zа-я]/.test(ch) ? to[idx].toUpperCase() : to[idx]) : s[i];
    }
    return out;
  }

  /** Нормализация ПО СИМВОЛАМ: та же длина, что и у исходной строки (для подсветки). */
  function normChars(s) {
    var str = s === null || s === undefined ? '' : String(s);
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var n = norm(str[i]);
      out += n.length === 1 ? n : str[i].toLowerCase();
    }
    return out;
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** 1234.5 -> "1 234,5" */
  function formatQty(v, decimals) {
    if (v === null || v === undefined || v === '' || isNaN(v)) return '';
    var d = decimals === undefined ? (Math.abs(v % 1) > 1e-9 ? 2 : 0) : decimals;
    var neg = v < 0;
    var parts = Math.abs(v).toFixed(d).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
    return (neg ? '-' : '') + parts.join(',');
  }

  function formatMoney(v) {
    if (v === null || v === undefined || v === '' || isNaN(v)) return '';
    return formatQty(Math.round(v * 100) / 100, v % 1 ? 2 : 0) + '\u00a0₽';
  }

  /**
   * Разбор количества из текста: "1 234,5" "1,234.56" "12 шт." "-" "нет" "" -> 0
   * @returns {{num:number, text:string, known:boolean}}
   */
  function parseQty(v) {
    if (v === null || v === undefined) return { num: 0, text: '', known: false };
    if (typeof v === 'number') return { num: v, text: String(v), known: isFinite(v) };
    if (v instanceof Date) return { num: v.getTime(), text: v.toISOString().slice(0, 10), known: true };
    var raw = String(v).trim();
    if (!raw) return { num: 0, text: '', known: false };
    var lower = norm(raw);
    if (/^(\u043d\u0435\u0442|no|null|none|\u2014|-|\.\.\.|0|\u0445|\u0443\u0442\u043e\u0447|\u043f\u043e\u0434 \u0437\u0430\u043a\u0430\u0437|\u043e\u0436\u0438|\u043e\u0442\u0441\u0443\u0442)/.test(lower)) {
      var early = lower.replace(/[^\d.,-]/g, '');
      if (!early) return { num: 0, text: raw, known: true };
    }
    var s = raw.replace(DASHES, '-').replace(/\s+/g, '').replace(/[^\d.,\-+eE]/g, '');
    if (!s) return { num: 0, text: raw, known: false };
    if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) {
      // разделитель тысяч — тот, что стоит левее
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
      if (/^-?\d+(\.\d{3})+$/.test(s) && s.length - s.indexOf('.') > 4 && (s.split('.')[1] || '').length % 3 === 0) {
        s = s.replace(/\./g, ''); // 1.234 -> 1234
      }
    }
    var num = parseFloat(s);
    if (!isFinite(num)) return { num: 0, text: raw, known: false };
    return { num: num, text: raw, known: true };
  }

  /** Число из заголовка/размера: "Ника 480х320" -> 480320, для «умной» сортировки. */
  var collator = null;
  function cmpStr(a, b) {
    if (!collator) {
      try { collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base', caseFirst: 'false' }); }
      catch (e) {
        collator = { compare: function (x, y) { x = String(x || ''); y = String(y || ''); return x < y ? -1 : x > y ? 1 : 0; } };
      }
    }
    return collator.compare(a || '', b || '');
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
    };
  }

  /** Разбить тяжёлую задачу на чанки, не вешая UI. */
  function eachChunk(items, worker, onProgress, onDone, budgetMs) {
    var i = 0, t0 = Date.now(), budget = budgetMs || 12;
    function step() {
      t0 = Date.now();
      while (i < items.length && Date.now() - t0 < budget) worker(items[i], i++);
      if (onProgress) onProgress(i, items.length);
      if (i < items.length) (root.requestAnimationFrame || setTimeout)(step, 0);
      else if (onDone) onDone();
    }
    step();
  }

  var uidCounter = 0;
  function uid(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + (++uidCounter).toString(36); }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function bytes(n) {
    if (!n && n !== 0) return '';
    var u = ['Б', 'КБ', 'МБ', 'ГБ'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1).replace(/,0$/, '') : n) + '\u00a0' + u[i];
  }

  function timeAgo(ts) {
    if (!ts) return '—';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return Math.floor(s / 60) + '\u00a0мин назад';
    if (s < 86400) return Math.floor(s / 3600) + '\u00a0ч назад';
    var d = new Date(ts);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  /** Мини-hyperscript для построения DOM. */
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = k === 'class' ? props[k] : props[k];
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === false || v === null || v === undefined) continue;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    }
    if (children !== undefined && children !== null) {
      if (!Array.isArray(children)) children = [children];
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
      }
    }
    return node;
  }

  /** Подсветка совпадений поиска. Возвращает HTML. */
  function highlight(text, tokens) {
    var s = text === null || text === undefined ? '' : String(text);
    if (!tokens || !tokens.length) return escapeHtml(s);
    var low = normChars(s);
    var marks = new Array(s.length);
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      if (!tok || tok.length < 1) continue;
      if (low.indexOf(tok) < 0) {
        var swapped = norm(swapLayout(tok));
        if (swapped && swapped !== tok && low.indexOf(swapped) >= 0) tok = swapped;
        else continue;
      }
      var from = 0, at;
      while ((at = low.indexOf(tok, from)) >= 0) {
        for (var j = at; j < at + tok.length && j < marks.length; j++) marks[j] = true;
        from = at + tok.length;
      }
    }
    var out = '', run = false;
    for (var i = 0; i < s.length; i++) {
      if (marks[i] && !run) { out += '<mark>'; run = true; }
      if (!marks[i] && run) { out += '</mark>'; run = false; }
      out += escapeHtml(s[i]);
    }
    if (run) out += '</mark>';
    return out;
  }

  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(ts); }
  }

  return {
    norm: norm, swapLayout: swapLayout, escapeHtml: escapeHtml, escapeRegExp: escapeRegExp,
    formatQty: formatQty, formatMoney: formatMoney, parseQty: parseQty, cmpStr: cmpStr,
    debounce: debounce, eachChunk: eachChunk, uid: uid, clamp: clamp, bytes: bytes,
    timeAgo: timeAgo, el: el, highlight: highlight, download: download, fmtDate: fmtDate
  };
});
