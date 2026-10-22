/*
 * «Остатки Ника 41» — попап: быстрый поиск по сохранённому прайсу.
 */
'use strict';

(function () {
  var U = window.OST, S = window.OST.search, ST = window.OST.store;
  var $ = function (s) { return document.querySelector(s); };
  var rows = [], ds = null, state = {}, limit = 12, lowStock = 5;
  var els = {};

  ['pq', 'res', 'state', 'stats', 'open', 'import', 'refresh', 'hint'].forEach(function (id) { els[id] = document.getElementById(id); });

  /** Открыть страницу прайса; запрос и действие передаём через chrome.storage.local —
   *  так же работает и когда вкладка прайса уже открыта (её переиспользует background). */
  function openApp(query, action) {
    var payload = {};
    if (query) payload.q = String(query);
    if (action) payload.action = action;
    var go = function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('app/index.html'), active: true });
      window.close();
    };
    if (Object.keys(payload).length) chrome.storage.local.set({ openRequest: payload }, function () {
      chrome.tabs.query({ url: chrome.runtime.getURL('app/index.html') }, function (tabs) {
        if (tabs && tabs.length) { chrome.tabs.update(tabs[0].id, { active: true }); window.close(); }
        else go();
      });
    });
    else go();
  }

  function ensureIndex() {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.s !== undefined) continue;
      r.cn = U.norm(r.c); r.nn = U.norm(r.n); r.sn = U.norm(r.sku); r.wn = U.norm(r.w);
      r.s = r.nn + ' \u0001 ' + r.cn + ' \u0001 ' + r.sn + ' \u0001 ' + r.wn + ' \u0001 ' + (r.pt || '');
    }
  }

  function render() {
    var q = els.pq.value.trim();
    var query = S.parseQuery(q);
    var out = [];
    var sum = 0, pos = 0, zero = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.q > 0) pos++; else zero++;
      if (query.empty) { if (out.length < limit) out.push({ i: i, s: 0 }); sum += r.q; continue; }
      var res = S.score(r, query);
      if (!res.ok) continue;
      sum += r.q;
      out.push({ i: i, s: res.score + (r.q > 0 ? 1000 : 0) });
    }
    if (!query.empty) {
      out.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
      out = out.slice(0, limit);
    }
    els.stats.innerHTML =
      stat('Позиций', U.formatQty(rows.length), '') +
      stat('В наличии', U.formatQty(pos), 'g') +
      stat('Нет', U.formatQty(zero), zero ? 'b' : '') +
      stat('Сумма', U.formatQty(sum), '');
    var toks = [];
    query.tokens.forEach(function (t) { toks = toks.concat(t.variants); });
    els.res.innerHTML = out.length
      ? out.map(function (o) {
        var r = rows[o.i];
        var cls = r.q < 0 ? 'neg' : r.q <= 0 ? 'zero' : r.q <= lowStock ? 'low' : 'pos';
        return '<li data-i="' + o.i + '"><span class="nm" title="' + U.escapeHtml(r.n) + '">' + U.highlight(r.n, toks) + '</span>' +
          '<span class="q ' + cls + '">' + U.formatQty(r.q) + '</span>' +
          '<span class="ch">' + (r.c ? '<span class="dot" style="--d:' + colorDot(r.c) + '"></span>' + U.highlight(r.c, toks) : '<span class="muted">без характеристики</span>') +
          (r.w ? ' · ' + U.escapeHtml(r.w) : '') + '</span></li>';
      }).join('')
      : (rows.length ? '<li class="empty">Ничего не найдено по запросу «' + U.escapeHtml(q) + '»</li>'
        : '<li class="empty">Прайс не загружен</li>');
    Array.prototype.forEach.call(els.res.querySelectorAll('li[data-i]'), function (li) {
      li.addEventListener('click', function () { openApp(q || rows[+li.dataset.i].n); });
    });
    els.hint.textContent = out.length ? 'Нажмите на строку — откроется в полном прайсе' : '';
  }

  function stat(label, v, cls) {
    return '<div class="st ' + cls + '"><span>' + label + '</span><b>' + v + '</b></div>';
  }

  var DOTS = [['бел', '#fff'], ['чёрн', '#1d1f21'], ['хром', '#ccd3d9'], ['сер', '#9aa1a8'], ['красн', '#c0392b'], ['син', '#1f4e9c'], ['зелен', '#2e7d46'], ['жёлт', '#e5c02c'], ['чёр', '#1d1f21']];
  function colorDot(name) {
    var n = U.norm(name);
    for (var i = 0; i < DOTS.length; i++) if (n.indexOf(DOTS[i][0]) >= 0) return DOTS[i][1];
    return '#c9ced3';
  }

  function load() {
    ST.loadSettings().then(function (s) { state = s || {}; lowStock = +state.lowStock || 5; return ST.loadState(); })
      .then(function (st2) {
        var id = st2 && st2.datasetId;
        return (id ? ST.loadDataset(id) : Promise.resolve(null)).then(function (d) {
          ds = d;
          if (!ds || !ds.rows) {
            els.state.innerHTML = '<span class="muted">прайс не загружен</span>';
            els.pq.disabled = true;
            els.stats.innerHTML = '';
            els.res.innerHTML = '<li class="empty">Сначала загрузите .xls с полной страницы расширения</li>';
            return null;
          }
          rows = ds.rows;
          els.state.innerHTML = U.escapeHtml((ds.fileName || 'прайс').replace(/\.[^.]+$/, '')) + '<br><span class="muted">' + U.timeAgo(ds.importedAt) + '</span>';
          ensureIndex();
          render();
          return null;
        });
      })
      .catch(function (e) { els.state.textContent = 'ошибка: ' + e.message; });
  }

  els.pq.addEventListener('input', debounce(render, 90));
  els.pq.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var li = els.res.querySelector('li[data-i]'); openApp(li ? rows[+li.dataset.i].n : els.pq.value.trim()); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var items = els.res.querySelectorAll('li[data-i]');
      if (!items.length) return;
      var idx = -1;
      for (var i = 0; i < items.length; i++) if (items[i].classList.contains('cur')) idx = i;
      idx = Math.min(items.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      Array.prototype.forEach.call(items, function (x) { x.classList.remove('cur'); });
      items[idx].classList.add('cur');
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  });
  els.open.addEventListener('click', function () { openApp(els.pq.value.trim() && els.pq.value); });
  els.import.addEventListener('click', function () { openApp(null, 'import'); });
  els.refresh.addEventListener('click', function () { openApp(null, 'refresh'); });

  // показать «↻», если за файлом сохранён доступ
  ST.get('kv', 'handle:current').then(function (h) { els.refresh.hidden = !h; });

  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  load();
  setTimeout(function () { els.pq.focus(); }, 40);
})();
