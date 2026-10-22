/*
 * «Остатки Ника 41» — страница прайса: импорт XLS, поиск, фасетные фильтры,
 * виртуальная таблица, группировка, экспорт, авто-обновление файла.
 */
(function (root) {
  'use strict';

  var U = root.OST, P = root.OST.parse, S = root.OST.search, ST = root.OST.store, FS = root.OST.fs;
  var XLSX = root.XLSX;

  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function on(node, ev, fn, opt) { if (node) node.addEventListener(ev, fn, opt); }

  /* ---------------- цвета → образцы ---------------- */
  var COLOR_HEX = [
    ['бел', '#ffffff'], ['чёрн', '#1d1f21'], ['черн', '#1d1f21'], ['хром', '#ccd3d9'], ['серебр', '#c7ccd1'],
    ['беж', '#e6dcc6'], ['молочн', '#f6f1e7'], ['крем', '#f0e2c8'], ['графит', '#41474d'], ['антрацит', '#2f3338'],
    ['сер', '#9aa1a8'], ['коричнев', '#6f4a2f'], ['кофе', '#6f4a2f'], ['коньяк', '#8b4513'], ['красн', '#c0392b'],
    ['син', '#1f4e9c'], ['голуб', '#8ec5e8'], ['зелен', '#2e7d46'], ['жёлт', '#e5c02c'], ['желт', '#e5c02c'],
    ['оранж', '#e07b1f'], ['розов', '#e58fae'], ['фиолет', '#6d4aa7'], ['бордо', '#6b1f2b'], ['бургунд', '#6b1f2b'],
    ['золот', '#c9a227'], ['латун', '#b08d57'], ['мед', '#b87333'], ['бронз', '#8c7853'], ['нерж', '#b9c0c6'],
    ['под золото', '#c9a227'], ['черн матов', '#191b1c'], ['мат', '#8d8f91'], ['сатин', '#d9dde1'], ['иней', '#dfe7ec'],
    ['дуб', '#9c6b3f'], ['орех', '#7a5230'], ['венге', '#3b2c25'], ['мрамор', '#d8d5cd'], ['чёрн хром', '#3a3f45'],
    ['transparent', '#e8eef4'], ['прозрачн', '#e8eef4'], ['синий хром', '#4b6f9a']
  ];
  function colorHex(name) {
    var n = U.norm(name);
    if (!n) return '';
    for (var i = 0; i < COLOR_HEX.length; i++) if (n.indexOf(COLOR_HEX[i][0]) >= 0) return COLOR_HEX[i][1];
    var h = 0;
    for (var j = 0; j < n.length; j++) h = (h * 31 + n.charCodeAt(j)) & 0xffffff;
    return '#' + ('000000' + (((h & 0xf0) << 12) | ((h & 0xff0) << 4) | ((h >> 4) & 0xf0)).toString(16)).slice(-6);
  }

  /* ---------------- состояние ---------------- */
  var state = {
    ds: null, book: null, sheetIdx: 0, sheets: [], aoa: null, headers: [], headerRow: 0, mapping: null,
    datasetId: null, fileName: '', fileMtime: 0, reuseConfig: true,
    q: '', query: { tokens: [], nots: [], empty: true },
    colors: [], wh: [], stock: [], qtyMin: '', qtyMax: '', priceMin: '', priceMax: '',
    sort: 'relevance', dir: 'asc', view: 'table', expanded: Object.create(null), sel: -1,
    lowStock: 5, density: 'compact', theme: 'auto', autoMin: 0, colorLimit: 28,
    facetClosed: Object.create(null), colorFilterText: '',
    filtered: null, order: [], viewRows: [], labels: { color: {}, wh: {} },
    hasHandle: false, timer: 0, indexed: false, lastRefresh: 0
  };
  var els = {};
  var ROW_H = 30;
  var pending = null, autoTimer = 0;

  function syncRowH() { ROW_H = state.density === 'comfortable' ? 40 : 30; }

  /* ==================== инициализация ==================== */
  function cacheEls() {
    ['app', 'q', 'q-clear', 'ds-info', 'ds-switch', 'btn-import', 'btn-refresh', 'btn-auto', 'btn-export',
      'btn-theme', 'btn-gear', 'chips', 'result-count', 'view-toggle', 'sort-select', 'sidebar', 'facets',
      'btn-reset', 'mapping-summary', 'btn-remap', 'scroller', 'grid', 'grid-cols', 'grid-head', 'tbody',
      'empty', 'empty-import', 'empty-demo', 'detail', 'detail-title', 'detail-close', 'detail-body',
      'dropzone', 'modal-root', 'toasts', 'stat-file', 'stat-progress', 'stat-note', 'loadbar', 'file-input'
    ].forEach(function (id) { els[id] = document.getElementById(id); });
  }

  function boot() {
    cacheEls();
    syncRowH();
    bindEvents();
    ST.loadSettings().then(function (s) {
      if (s) applySettings(s, true);
      return ST.loadState();
    }).then(function (saved) {
      var hash = readHash();
      var id = hash.ds || (saved && saved.datasetId);
      els['stat-note'].innerHTML = ST.persistent()
        ? 'данные хранятся локально (IndexedDB)'
        : '<b>внимание:</b> локальное хранилище недоступно — прайс живёт до закрытия вкладки';
      var load = id ? ST.loadDataset(id) : Promise.resolve(null);
      refreshList();
      return load.then(function (ds) {
        if (ds && ds.rows && ds.rows.length) {
          adoptDataset(ds, { fromStore: true, keepFilters: true });
        } else if (id) {
          showEmpty('Сохранённый прайс не найден — загрузите файл снова.');
        }
        return FS.loadHandle('current');
      }).then(function (h) {
        state.hasHandle = !!h;
        toggleRefreshUI();
        if (state.autoMin && state.hasHandle) startAuto();
      }).catch(function (e) { console.warn(e); });
    }).then(function () { consumeOpenRequest(); });
  }

  function applySettings(s, silent) {
    ['lowStock', 'density', 'theme', 'autoMin', 'colorLimit', 'reuseConfig', 'view', 'sort'].forEach(function (k) {
      if (s[k] !== undefined && s[k] !== null) state[k] = s[k];
    });
    document.documentElement.setAttribute('data-density', state.density || 'compact');
    document.documentElement.setAttribute('data-theme', state.theme || 'auto');
    syncRowH();
    $$('#view-toggle .seg-btn').forEach(function (b) { b.classList.toggle('is-on', b.dataset.view === state.view); });
    if (!silent && state.ds) refresh();
    restartAuto();
  }

  function saveSettings() {
    var o = {};
    ['lowStock', 'density', 'theme', 'autoMin', 'colorLimit', 'reuseConfig', 'view', 'sort'].forEach(function (k) { o[k] = state[k]; });
    ST.saveSettings(o);
    if (root.chrome && chrome.storage && chrome.storage.local) { try { chrome.storage.local.set({ settings: o }); } catch (e) { } }
  }

  /* ==================== импорт ==================== */
  function bindEvents() {
    on(els['btn-import'], 'click', function () { pickViaInput(); });
    on(els['empty-import'], 'click', function () { pickViaInput(); });
    on(els['empty-demo'], 'click', loadDemo);
    on(els['file-input'], 'change', function (e) { if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });
    on(els['q'], 'input', U.debounce(function (e) {
      state.q = e.target.value;
      state.query = S.parseQuery(state.q);
      els['q-clear'].hidden = !state.q;
      if (!state.q) { state.sort = state.q ? 'relevance' : state.sort; }
      refresh({ soft: true });
    }, 90));
    on(els['q'], 'keydown', function (e) { if (e.key === 'Escape') { e.target.value = ''; state.q = ''; state.query = S.parseQuery(''); els['q-clear'].hidden = true; refresh({ soft: true }); } });
    on(els['q-clear'], 'click', function () { els['q'].value = ''; state.q = ''; state.query = S.parseQuery(''); els['q-clear'].hidden = true; els['q'].focus(); refresh({ soft: true }); });
    on(els['btn-reset'], 'click', resetFilters);
    on(els['btn-remap'], 'click', function () { openRemap(false); });
    on(els['btn-theme'], 'click', cycleTheme);
    on(els['btn-gear'], 'click', openSettings);
    on(els['btn-export'], 'click', openExport);
    on(els['btn-refresh'], 'click', function () { manualRefresh(); });
    on(els['btn-auto'], 'click', function () { openSettings('auto'); });
    on(els['detail-close'], 'click', function () { closeDetail(); });
    on(els['ds-switch'], 'change', function (e) { switchDataset(e.target.value); });
    on(els['sort-select'], 'change', function (e) { state.sort = e.target.value; if (state.sort !== 'relevance' && state.sort !== 'default' && state.sort !== 'qty' && state.sort !== 'price') state.dir = 'asc'; refresh(); saveSettings(); });
    $$('#view-toggle .seg-btn').forEach(function (b) {
      on(b, 'click', function () {
        state.view = b.dataset.view;
        $$('#view-toggle .seg-btn').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        els['scroller'].scrollTop = 0;
        refresh(); saveSettings();
      });
    });
    // drag&drop
    var dragDepth = 0;
    on(window, 'dragenter', function (e) { if (hasFiles(e)) { e.preventDefault(); dragDepth++; els['dropzone'].hidden = false; } });
    on(window, 'dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); } });
    on(window, 'dragleave', function (e) { if (--dragDepth <= 0) { dragDepth = 0; els['dropzone'].hidden = true; } });
    on(window, 'drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault(); dragDepth = 0; els['dropzone'].hidden = true;
      handleFile(e.dataTransfer.files[0]);
    });
    on(window, 'hashchange', function () { readHash(true); });
    on(window, 'resize', U.debounce(function () { renderBody(); }, 120));
    on(els['scroller'], 'scroll', function () { if (!pending) pending = requestAnimationFrame(function () { pending = 0; renderBody(); }); });
    on(els['tbody'], 'click', onGridClick);
    on(els['grid-head'], 'click', onHeadClick);
    on(document, 'keydown', onKeys);
    on(document, 'visibilitychange', function () { if (!document.hidden) { ST.loadSettings().then(function (s) { if (s) applySettings(s); }); } });
    if (root.chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (ch, area) {
        if (area !== 'local') return;
        if (ch.settings) ST.loadSettings().then(function (s) { if (s) applySettings(s); });
        if (ch.openRequest && ch.openRequest.newValue) { applyOpenRequest(ch.openRequest.newValue); }
      });
    }
    if (root.chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.type === 'focus-search') { els['q'].focus(); els['q'].select(); }
        if (msg && msg.type === 'refresh') manualRefresh();
        return false;
      });
    }
  }

  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.items) { for (var i = 0; i < dt.items.length; i++) if (dt.items[i].kind === 'file') return true; }
    return !!(dt.files && dt.files.length);
  }

  function pickViaInput() {
    if (FS.supported()) {
      FS.pick().then(function (handle) {
        if (!handle) return;
        state.hasHandle = true;
        return FS.readFile(handle).then(function (r) {
          return handleFile(r.file, handle);
        });
      }).catch(function (e) { toast(errText(e), 'err'); });
      return;
    }
    els['file-input'].click();
  }

  function errText(e) {
    var m = (e && e.message) ? e.message : String(e || 'ошибка');
    return m === 'user cancelled' || /abort/i.test(m) ? 'Импорт отменён' : m;
  }

  function handleFile(file, handle) {
    setBusy('Читаю «' + U.escapeHtml(file.name) + '»…', -1);
    var p = handle
      ? FS.readFile(handle).then(function (r) { return { buffer: r.buffer, name: r.name, size: r.size, mtime: r.mtime }; })
      : file.arrayBuffer().then(function (b) { return { buffer: b, name: file.name, size: file.size, mtime: +file.lastModified }; });
    return p.then(function (r) {
      return ingest(r.buffer, { fileName: r.name, fileSize: r.size, fileMtime: r.mtime, fresh: true, handle: handle });
    }).catch(function (e) {
      setBusy('', 0);
      toast(errText(e), 'err');
    });
  }

  /**
   * буфер -> датасет. fresh = загружаем новый файл (автонастройка колонок),
   * иначе перечитывание того же файла с сохранением настроек.
   */
  function ingest(buffer, meta) {
    var book;
    try { book = P.readWorkbook(buffer, meta.fileName); }
    catch (e) { setBusy('', 0); toast('Не удалось открыть файл: ' + errText(e), 'err'); return Promise.reject(e); }
    var idx = 0;
    if (meta.fresh || !state.sheetName) {
      var best = -1;
      for (var i = 0; i < book.sheets.length; i++) {
        var est = book.sheets[i].rows;
        if (est > best) { best = est; idx = i; }
      }
    } else {
      for (var j = 0; j < book.sheets.length; j++) if (book.sheets[j].name === state.sheetName) { idx = j; break; }
    }
    var sheet = book.sheets[idx];
    if (!sheet || !sheet.aoa.length) { setBusy('', 0); toast('В файле нет данных', 'err'); return Promise.reject(new Error('empty')); }

    var det, mapping;
    if (!meta.fresh && state.reuseConfig && state.mapping) {
      det = { index: state.headerRow, headers: state.headers, score: 99 };
      mapping = cloneMapping(state.mapping);
    } else {
      det = P.detectHeader(sheet.aoa);
      mapping = P.detectMapping(det.headers, sheet.aoa, det.index);
    }
    var ds = P.buildDataset({
      aoa: sheet.aoa, headers: det.headers, headerRow: det.index, mapping: mapping,
      fileName: meta.fileName, fileSize: meta.fileSize, fileMtime: meta.fileMtime,
      sheetName: sheet.name, id: state.datasetId || U.uid('ds')
    });
    // пока файл не признан прайсом — состояние не трогаем (испорченный файл не должен ничего затирать)
    if (!ds.stats.rows || !(ds.mapping.qty >= 0 || ds.mapping.char >= 0 || ds.mapping.price >= 0)) {
      setBusy('', 0);
      toast('Файл не похож на прайс-лист: нет ни строк данных, ни колонки с остатками. Прежний прайс сохранён.', 'err');
      return Promise.reject(new Error('не похоже на прайс-лист'));
    }
    state.book = book;
    state.datasetId = ds.id;
    state.fileName = meta.fileName;
    state.fileMtime = meta.fileMtime || 0;
    var saveHandleP = meta.handle ? FS.saveHandle('current', meta.handle) : (meta.fresh ? Promise.resolve(false) : Promise.resolve(state.hasHandle));
    saveHandleP.then(function (ok) { state.hasHandle = !!ok || !!meta.handle; });

    var confident = ds.stats.rows > 0 && ds.mapping.name >= 0 && ds.mapping.qty >= 0 && (det.index >= 0 || ds.mapping.char >= 0);
    return Promise.resolve().then(function () {
      if (!confident) {
        // нужен ручной выбор: показываем окно, а отмена вернёт прежний прайс
        if (state.ds && state.ds.stats && state.ds.stats.rows) state.backup = snapshot();
        adoptDataset(ds, { keepFilters: !meta.fresh, noRender: !!state.backup });
        setBusy('', 0);
        openRemap(true);
        return;
      }
      return adoptDataset(ds, { keepFilters: !meta.fresh });
    }).then(function () {
      if (state.backup) { state.backup = null; }
      return ST.saveDataset(ds, buffer).then(function () {
        return ST.saveState({ datasetId: ds.id, fileName: meta.fileName, at: Date.now() });
      }).catch(function (e) { console.warn('store', e); });
    }).then(function () {
      refreshList();
      setBusy('', 0);
      state.lastRefresh = Date.now();
      var added = ds.stats.rows;
      toast(meta.fresh
        ? 'Загружено <b>' + U.escapeHtml(meta.fileName) + '</b>: ' + added + ' строк, ' + U.formatQty(ds.stats.sumQty) + ' шт на складе'
        : 'Прайс обновлён: ' + added + ' строк', 'ok', state.hasHandle ? { label: 'Автообновление', fn: function () { openSettings('auto'); } } : null);
      updateBadge();
    });
  }

  function snapshot() {
    var snap = {};
    ['ds', 'book', 'aoa', 'sheetName', 'sheetIdx', 'headers', 'headerRow', 'mapping', 'datasetId', 'fileName', 'fileMtime', 'colors', 'wh', 'stock'].forEach(function (k) { snap[k] = state[k]; });
    snap.labels = state.labels;
    return snap;
  }

  function restoreBackup() {
    var b = state.backup;
    if (!b) return false;
    ['ds', 'book', 'aoa', 'sheetName', 'sheetIdx', 'headers', 'headerRow', 'mapping', 'datasetId', 'fileName', 'fileMtime', 'colors', 'wh', 'stock'].forEach(function (k) { state[k] = b[k]; });
    state.labels = b.labels;
    state.backup = null;
    refresh();
    toast('Импорт отменён — прежний прайс на месте');
    return true;
  }

  function cloneMapping(m) {
    var o = {};
    for (var k in m) o[k] = Array.isArray(m[k]) ? m[k].slice() : m[k];
    return o;
  }

  function adoptDataset(ds, opts) {
    opts = opts || {};
    state.ds = ds;
    state.sheetName = ds.sheetName;
    state.sheetIdx = 0;
    state.headers = ds.headersRaw || ds.columns.map(function (c) { return c.label; });
    state.headerRow = ds.headerRow;
    state.mapping = cloneMapping(ds.mapping);
    state.sheetNames = (state.book && state.book.sheets ? state.book.sheets.map(function (s) { return s.name; }) : [ds.sheetName]);
    if (state.book && state.book.sheets) {
      for (var i = 0; i < state.book.sheets.length; i++) if (state.book.sheets[i].name === ds.sheetName) state.sheetIdx = i;
      state.aoa = state.book.sheets[state.sheetIdx] ? state.book.sheets[state.sheetIdx].aoa : null;
    }
    state.sheets = (state.book && state.book.sheets) ? state.book.sheets.map(function (s, k) {
      var d = P.detectHeader(s.aoa);
      return { name: s.name, rows: s.rows, headerRow: d.index, estimated: s.aoa.length - d.index - 1 };
    }) : [];
    document.body.classList.add('has-data');
    els['q'].focus();
    if (!opts.keepFilters) { state.colors = []; state.wh = []; state.stock = []; state.qtyMin = state.qtyMax = ''; state.priceMin = state.priceMax = ''; }
    buildLabels(ds);
    if (opts.noRender) return Promise.resolve();
    return indexAndRender(ds);
  }

  function buildLabels(ds) {
    state.labels = { color: Object.create(null), wh: Object.create(null), colorTotal: Object.create(null), whTotal: Object.create(null) };
    for (var i = 0; i < ds.rows.length; i++) {
      var r = ds.rows[i];
      if (r.c) { var cn = U.norm(r.c); if (!state.labels.color[cn]) state.labels.color[cn] = r.c; state.labels.colorTotal[cn] = (state.labels.colorTotal[cn] || 0) + 1; }
      if (r.w) { var wn = U.norm(r.w); if (!state.labels.wh[wn]) state.labels.wh[wn] = r.w; state.labels.whTotal[wn] = (state.labels.whTotal[wn] || 0) + 1; }
    }
  }

  function indexAndRender(ds) {
    var t0 = performance.now();
    setBusy('Строю индекс поиска…', 0);
    return S.buildIndex(ds.rows, function (done, total) {
      if (total > 20000) setBusy('Индекс: ' + Math.round(done / total * 100) + '%', done / total);
    }).then(function () {
      setBusy('', 0);
      state.indexed = true;
      if (state.q) state.query = S.parseQuery(state.q);
      refresh();
      var ms = Math.round(performance.now() - t0);
      if (ds.stats.rows > 20000) toast('Проиндексировано ' + U.formatQty(ds.stats.rows) + ' строк за ' + ms + ' мс', 'ok');
      updateBadge();
    });
  }

  /* ==================== расчёт и отрисовка ==================== */
  function refresh(opts) {
    opts = opts || {};
    if (!state.ds) { renderChips(); renderCount(); return; }
    var st = {
      query: state.query, colors: state.colors, wh: state.wh, stock: state.stock,
      qtyMin: state.qtyMin === '' ? null : +state.qtyMin, qtyMax: state.qtyMax === '' ? null : +state.qtyMax,
      priceMin: state.priceMin === '' ? null : +state.priceMin, priceMax: state.priceMax === '' ? null : +state.priceMax,
      lowStock: +state.lowStock, hasSkuOnly: false, colorsRequireValue: !!state.colors.length, onlyWithoutStock: false
    };
    var sortKey = (state.q && !state.query.empty && state.sort === 'relevance') ? 'relevance' : (state.sort === 'relevance' ? 'default' : state.sort);
    st.sort = sortKey;
    var res = S.apply(state.ds, st);
    state.filtered = res;
    state.order = S.sortRows(state.ds.rows, res.list, sortKey, state.dir, res.scores || null);
    if (state.view === 'groups') flattenGroups();
    else state.viewRows = state.order.map(function (i) { return { t: 'r', i: i }; });
    if (!opts.soft) els['scroller'].scrollTop = 0;
    render(opts);
    writeHash();
    if (!opts.soft) updateBadge();
  }

  function flattenGroups() {
    var groups = S.groupRows(state.ds.rows, state.order, { sort: state.sort === 'relevance' || state.sort === 'default' ? 'name' : state.sort, dir: state.dir });
    state.groups = groups;
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      out.push({ t: 'g', g: g, key: groups[g].key });
      if (state.expanded[groups[g].key]) {
        var items = groups[g].items;
        for (var i = 0; i < items.length; i++) out.push({ t: 's', i: items[i], g: g });
      }
    }
    state.viewRows = out;
  }

  function render(opts) {
    renderHead();
    renderBody();
    renderChips();
    renderFacets();
    renderCount();
    renderMapSummary();
    if (state.sel >= 0 && opts && opts.keepDetail) renderDetail(state.sel);
  }

  function columns() {
    var out = [{ key: 'idx', label: '№', w: 46, sortable: false }];
    out.push({ key: 'name', label: 'Номенклатура', w: null });
    out.push({ key: 'char', label: 'Характеристика', w: 168 });
    out.push({ key: 'qty', label: 'Остаток', w: 92 });
    var cols = state.ds ? state.ds.columns : [];
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      if (c.key === 'price' || c.key === 'sku' || c.key === 'warehouse' || c.key === 'unit' || c.key === 'min' || c.extra) {
        out.push({ key: c.key, label: c.label, w: c.key === 'price' ? 96 : c.key === 'sku' ? 108 : c.key === 'min' ? 82 : 120 });
      }
    }
    return out;
  }

  function renderHead() {
    if (!state.ds) return;
    var cols = columns();
    var cg = '', th = '';
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      cg += '<col' + (c.w ? ' style="width:' + c.w + 'px"' : (c.key === 'idx' ? '' : '')) + '>';
      var arrow = '';
      if (c.key === state.sort) arrow = '<span class="arw">' + (state.dir === 'desc' ? '▼' : '▲') + '</span>';
      th += '<th data-sort="' + c.key + '" class="' + (c.sortable === false ? 'nosort' : '') + '" title="' + U.escapeHtml(c.sortable === false ? '' : 'Сортировать по «' + c.label + '»') + '">' + U.escapeHtml(c.label) + ' ' + arrow + '</th>';
    }
    els['grid-cols'].innerHTML = cg;
    els['grid-head'].innerHTML = '<tr>' + th + '</tr>';
  }

  function rowHtml(r, i, cls) {
    var ds = state.ds, low = +state.lowStock;
    var q = r.q;
    var qcls = q < 0 ? 'qty-neg' : q <= 0 ? 'qty-zero' : q <= low ? 'qty-low' : 'qty-pos';
    var pill = q < 0 ? 'neg' : q <= 0 ? 'zero' : q <= low ? 'low' : 'pos';
    var h = state.q ? state.query : { tokens: [] };
    var name = U.highlight(r.n, tokensOf(h));
    var charHtml = r.c ? '<span class="dotc" style="--dot:' + colorHex(r.c) + '"></span>' + U.highlight(r.c, tokensOf(h)) : '<span class="qty-zero">—</span>';
    var out = '<tr data-i="' + i + '" class="' + (cls || '') + (state.sel === i ? ' is-sel' : '') + '">' +
      '<td class="c-idx">' + (i + 1) + '</td>' +
      '<td class="c-name" title="' + U.escapeHtml(r.n) + '">' + name + '</td>' +
      '<td class="c-char" title="' + U.escapeHtml(r.c) + '">' + charHtml + '</td>' +
      '<td class="c-qty"><span class="pill pill-' + pill + ' ' + qcls + '">' + U.formatQty(q) + '</span></td>';
    var cols = columns();
    for (var k = 4; k < cols.length; k++) {   // 0..3 = №, наименование, характеристика, остаток
      var key = cols[k].key;
      var val = '';
      if (key === 'price') val = r.p === null || r.p === undefined ? '' : U.formatMoney(r.p);
      else if (key === 'sku') val = U.highlight(r.sku, tokensOf(h));
      else if (key === 'warehouse') val = U.highlight(r.w, tokensOf(h));
      else if (key === 'unit') val = '';
      else if (key === 'min') val = '';
      else if (key.slice(0, 1) === 'x') val = U.escapeHtml(r.x && r.x[+key.slice(1)] !== undefined ? r.x[+key.slice(1)] : '');
      out += '<td class="c-extra c-' + key + '" title="' + U.escapeHtml(val.replace(/<[^>]+>/g, '')) + '">' + val + '</td>';
    }
    return out + '</tr>';
  }

  function tokensOf(h) {
    if (!h || !h.tokens) return [];
    var t = [];
    for (var i = 0; i < h.tokens.length; i++) for (var j = 0; j < h.tokens[i].variants.length; j++) t.push(h.tokens[i].variants[j]);
    return t;
  }

  function groupHtml(g, gi) {
    var open = !!state.expanded[g.key];
    var low = +state.lowStock;
    var sum = g.total;
    var pill = sum < 0 ? 'neg' : sum <= 0 ? 'zero' : sum <= low ? 'low' : 'pos';
    var toks = tokensOf(state.query);
    var swatch = g.colorList.slice(0, 8).map(function (c) {
      return '<span class="dotc" style="--dot:' + colorHex(state.labels.color[c] || c) + ';margin-right:2px" title="' + U.escapeHtml(state.labels.color[c] || c) + '"></span>';
    }).join('');
    return '<tr class="grp" data-g="' + gi + '">' +
      '<td class="c-idx">' + (gi + 1) + '</td>' +
      '<td class="c-name"><span class="caret">' + (open ? '▾' : '▸') + '</span>' + U.highlight(g.name, toks) +
      ' <span class="grp-colors">' + g.count + ' ' + plural(g.count, ['цвет', 'цвета', 'цветов']) + '</span></td>' +
      '<td class="c-char">' + swatch + '</td>' +
      '<td class="c-qty"><span class="pill pill-' + pill + '">' + U.formatQty(sum) + '</span></td>' +
      '<td colspan="' + Math.max(0, columns().length - 4) + '"></td></tr>';
  }

  function plural(n, forms) {
    var n10 = n % 10, n100 = n % 100;
    return forms[n10 === 1 && n100 !== 11 ? 0 : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 1 : 2];
  }

  function renderBody() {
    if (!state.ds) { els['tbody'].innerHTML = ''; return; }
    var total = state.viewRows.length;
    var count = Math.ceil(els['scroller'].clientHeight / ROW_H) + 10;
    var start = U.clamp(Math.floor(els['scroller'].scrollTop / ROW_H) - 5, 0, Math.max(0, total));
    var end = U.clamp(start + count, 0, total);
    var colCount = columns().length;
    var html = '';
    if (start > 0) html += '<tr class="pad" style="--pad:' + (start * ROW_H) + 'px"><td colspan="' + colCount + '"><div></div></td></tr>';
    for (var i = start; i < end; i++) {
      var vr = state.viewRows[i];
      if (vr.t === 'g') html += groupHtml(state.groups[vr.g], vr.g);
      else html += rowHtml(state.ds.rows[vr.i], vr.i, vr.t === 's' ? 'sub' : '');
    }
    if (end < total) html += '<tr class="pad" style="--pad:' + ((total - end) * ROW_H) + 'px"><td colspan="' + colCount + '"><div></div></td></tr>';
    els['tbody'].innerHTML = html;
  }

  function renderCount() {
    if (!state.ds) { els['result-count'].textContent = '—'; return; }
    var f = state.filtered;
    var matched = f ? f.agg.matched : 0;
    var all = state.ds.stats.rows;
    var txt = '<b>' + U.formatQty(matched) + '</b> из ' + U.formatQty(all) + ' ' + plural(all, ['строка', 'строки', 'строк']);
    if (matched !== all) txt += ' · остаток выборки <b>' + U.formatQty(f.agg.sum) + '</b> шт';
    else txt += ' · всего <b>' + U.formatQty(f.agg.sum) + '</b> шт';
    if (state.view === 'groups' && state.groups) txt += ' · ' + U.formatQty(state.groups.length) + ' ' + plural(state.groups.length, ['позиция', 'позиции', 'позиций']);
    els['result-count'].innerHTML = txt;
    els['ds-info'].innerHTML = U.escapeHtml(state.ds.fileName || 'прайс') + ' · лист «' + U.escapeHtml(state.ds.sheetName || '') + '» · ' + U.timeAgo(state.ds.importedAt);
    els['stat-file'].innerHTML = 'файл <b>' + U.escapeHtml(state.ds.fileName || '—') + '</b>' + (state.ds.fileSize ? ' · ' + U.bytes(state.ds.fileSize) : '') + (state.fileMtime ? ' · изменён ' + U.fmtDate(state.fileMtime) : '') + (state.lastRefresh ? ' · обновлён ' + U.timeAgo(state.lastRefresh) : '');
  }

  function renderMapSummary() {
    if (!state.ds) { els['mapping-summary'].innerHTML = ''; return; }
    var m = state.ds.mapping, h = state.headers;
    function f(key, label) {
      var i = m[key];
      return '<div>' + label + ': <b>' + (i >= 0 ? U.escapeHtml(h[i] || ('колонка ' + (i + 1))) : '—') + '</b></div>';
    }
    els['mapping-summary'].innerHTML = f('name', 'Номенклатура') + f('char', 'Характеристика') + f('qty', 'Остаток') + f('price', 'Цена') +
      '<div>Строк: <b>' + U.formatQty(state.ds.stats.rows) + '</b> · шапка: <b>' + (state.headerRow >= 0 ? 'строка ' + (state.headerRow + 1) : 'нет') + '</b></div>';
  }

  /* ---------- чипы ---------- */
  function renderChips() {
    var out = [];
    if (state.q) out.push(chip('Поиск', state.q, function () { els['q'].value = ''; state.q = ''; state.query = S.parseQuery(''); els['q-clear'].hidden = true; refresh({ soft: true }); els['q'].focus(); }));
    state.stock.forEach(function (v) {
      out.push(chip('Наличие', stockLabel(v), rm('stock', v)));
    });
    state.colors.forEach(function (v) {
      var e = document.createElement('span');
      e.className = 'chip';
      e.innerHTML = '<span class="dotc" style="--dot:' + colorHex(state.labels.color[v] || v) + '"></span>Цвет: <b>' + U.escapeHtml(state.labels.color[v] || v) + '</b>';
      var b = document.createElement('button'); b.className = 'chip-x'; b.textContent = '✕'; b.title = 'Убрать фильтр';
      b.addEventListener('click', function () { toggleIn(state.colors, v, true); });
      e.appendChild(b);
      out.push(e);
    });
    state.wh.forEach(function (v) { out.push(chip('Склад', state.labels.wh[v] || v, rm('wh', v))); });
    if (state.qtyMin !== '' || state.qtyMax !== '') {
      out.push(chip('Остаток', (state.qtyMin === '' ? 'от −∞' : 'от ' + state.qtyMin) + ' ' + (state.qtyMax === '' ? '' : 'до ' + state.qtyMax), function () { state.qtyMin = state.qtyMax = ''; refresh(); }));
    }
    if (state.priceMin !== '' || state.priceMax !== '') {
      out.push(chip('Цена', (state.priceMin === '' ? '' : 'от ' + state.priceMin) + (state.priceMax === '' ? (state.priceMin === '' ? '' : '') : 'до ' + state.priceMax), function () { state.priceMin = state.priceMax = ''; refresh(); }));
    }
    els['chips'].innerHTML = '';
    if (!state.ds) { els['chips'].innerHTML = '<span class="f-empty">Загрузите прайс-лист — появится поиск и живые фильтры</span>'; return; }
    for (var i = 0; i < out.length; i++) els['chips'].appendChild(out[i]);
    if (out.length > 1 || (out.length === 1 && !state.q)) {
      var clr = document.createElement('button');
      clr.className = 'link-btn'; clr.textContent = 'Сбросить всё';
      clr.addEventListener('click', resetFilters);
      els['chips'].appendChild(clr);
    }
  }

  function chip(label, value, onX) {
    var e = U.el('span', { class: 'chip' }, [document.createTextNode(label + ': '), U.el('b', { text: value })]);
    if (onX) {
      var b = U.el('button', { class: 'chip-x', title: 'Убрать фильтр', text: '✕' });
      b.addEventListener('click', onX);
      e.appendChild(b);
    }
    return e;
  }
  function rm(field, v) { return function () { toggleIn(state[field], v, true); }; }
  function toggleIn(arr, v, onlyRemove) {
    var i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else if (!onlyRemove) arr.push(v);
    refresh();
  }

  function stockLabel(v) {
    return ({ in: 'в наличии', low: 'мало', zero: 'нет в наличии', neg: 'минус' })[v] || v;
  }

  function resetFilters() {
    state.colors = []; state.wh = []; state.stock = [];
    state.qtyMin = state.qtyMax = state.priceMin = state.priceMax = '';
    els['color-filter-input'] && (els['color-filter-input'].value = '');
    state.colorFilterText = '';
    refresh();
  }

  /* ---------- фасеты ---------- */
  function renderFacets() {
    var box = els['facets'];
    if (!state.ds) { box.innerHTML = ''; return; }
    var f = state.filtered;
    var html = '';
    // наличие
    var stockOrder = ['in', 'low', 'zero', 'neg'];
    var stockCounts = f ? f.facets.stock : {};
    var anyNeg = (stockCounts.neg || 0) > 0;
    html += facet('stock', 'Наличие', sum(stockCounts),
      stockOrder.filter(function (k) { return k !== 'neg' || anyNeg; }).map(function (k) {
        return opt('stock', k, stockLabel(k), stockCounts[k] || 0, state.stock.indexOf(k) >= 0, k === 'zero' ? 'is-zero' : '');
      }).join(''));
    // цвета
    var colors = facetList(f ? f.facets.color : {}, 'color', state.colors);
    var shown = colors.list.slice(0, state.colorLimit);
    var more = colors.total - shown.length;
    html += facet('color', 'Цвет / характеристика', colors.totalAll,
      (colors.total > 8 ? '<input class="f-search" id="color-filter-input" placeholder="Фильтр по списку цветов…" value="' + U.escapeHtml(state.colorFilterText) + '">' : '') +
      shown.map(function (it) {
        return opt('color', it.v, it.label, it.n, state.colors.indexOf(it.v) >= 0, (it.n === 0 ? 'is-dim ' : '') + (it.total > 999 ? '' : ''), colorHex(it.label));
      }).join('') +
      (shown.length === 0 ? '<div class="f-empty">Ничего не найдено</div>' : '') +
      (more > 0 ? '<button class="link-btn" data-more="color">Показать все ' + more + '</button>' : '') +
      '<div class="f-op"><button data-only="color">Только выбранное</button><button data-clear="color">Снять</button></div>');
    // склады
    if (state.ds.hasWarehouse) {
      var whs = facetList(f ? f.facets.warehouse : {}, 'wh', state.wh);
      html += facet('wh', 'Склад', whs.totalAll,
        whs.list.map(function (it) { return opt('wh', it.v, it.label, it.n, state.wh.indexOf(it.v) >= 0, it.n === 0 ? 'is-dim' : ''); }).join('') +
        '<div class="f-op"><button data-clear="wh">Снять</button></div>');
    }
    // остаток
    var qr = f ? f.ranges.qty : { min: 0, max: 0 };
    html += facet('qty', 'Остаток, шт', null,
      range('qty', state.qtyMin, state.qtyMax, qr) +
      '<div class="quick">' +
      quick('qty', '1', '≥ 1', 1, '') + quick('qty', '5', '≥ 5', 5, '') +
      quick('qty', '10', '≥ 10', 10, '') + quick('qty', '50', '≥ 50', 50, '') +
      quick('qty', '100', '≥ 100', 100, '') + quick('zero', '= 0', 'нет', '', '') +
      '</div>');
    // цена
    if (state.ds.hasPrice) {
      var pr = f ? f.ranges.price : { min: 0, max: 0 };
      html += facet('price', 'Цена, ₽', null, range('price', state.priceMin, state.priceMax, pr));
    }
    box.innerHTML = html;
    wireFacets();
  }

  function sum(o) { var s = 0; for (var k in o) s += o[k]; return s; }

  /**
   * Значения фасета: всегда показываем ВСЁ множество значений колонки (иначе при
   * выбранном фильтре список «схлопывается» и фильтр нельзя поправить), но счётчик —
   * с учётом остальных фильтров; нулевые значения приглушены.
   */
  function facetList(counts, field, selected) {
    var storeKey = field === 'color' ? 'color' : 'wh';
    var labels = state.labels[storeKey] || {};
    var totals = state.labels[field === 'color' ? 'colorTotal' : 'whTotal'] || {};
    var items = [], seen = Object.create(null);
    var totalAll = 0;
    for (var t in totals) { items.push({ v: t, n: (counts && counts[t]) || 0, total: totals[t], label: labels[t] || (t ? t : '—') }); seen[t] = 1; }
    for (var k in counts) { totalAll += counts[k]; if (!counts[k] || seen[k]) continue; items.push({ v: k, n: counts[k], total: counts[k], label: labels[k] || (k ? k : '—') }); }
    items.sort(function (a, b) {
      var an = selected.indexOf(a.v) >= 0, bn = selected.indexOf(b.v) >= 0;
      if (an !== bn) return an ? -1 : 1;
      if (!!a.n !== !!b.n) return a.n ? -1 : 1;
      return (b.n - a.n) || (b.total - a.total) || U.cmpStr(a.label, b.label);
    });
    var text = state.colorFilterText;
    if (field === 'color' && text) {
      var nt = U.norm(text);
      items = items.filter(function (i) { return U.norm(i.label).indexOf(nt) >= 0 || i.v.indexOf(nt) >= 0; });
    }
    return { list: items, total: items.length, totalAll: totalAll };
  }

  function facet(key, title, count, body) {
    var closed = state.facetClosed[key] ? ' closed' : '';
    return '<section class="facet' + closed + '" data-facet="' + key + '">' +
      '<div class="facet-head"><span class="caret">▾</span><b>' + title + '</b>' +
      (count === null ? '' : '<span class="cnt">' + U.formatQty(count) + '</span>') + '</div>' +
      '<div class="facet-body">' + body + '</div></section>';
  }

  function opt(field, val, label, count, checked, cls, dot) {
    var id = 'f_' + field + '_' + val.replace(/[^\wа-яё-]/gi, '_');
    return '<label class="fopt ' + (cls || '') + '"' + (dot ? ' style="--dot:' + dot + '"' : '') + (dot ? ' data-dot="1"' : '') + '>' +
      (dot ? '<span class="dotc" style="--dot:' + dot + ';margin:0"></span>' : '') +
      '<input type="checkbox" id="' + id + '" data-field="' + field + '" data-value="' + U.escapeHtml(String(val)) + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="lbl" title="' + U.escapeHtml(label) + '">' + U.escapeHtml(label) + '</span>' +
      '<span class="num">' + U.formatQty(count) + '</span></label>';
  }

  function range(field, lo, hi, bounds) {
    return '<div class="range"><input type="number" inputmode="decimal" placeholder="от ' + fmtBound(bounds.min) + '" data-range="' + field + '" data-edge="min" value="' + (lo === '' ? '' : lo) + '">' +
      '<span>—</span><input type="number" inputmode="decimal" placeholder="до ' + fmtBound(bounds.max) + '" data-range="' + field + '" data-edge="max" value="' + (hi === '' ? '' : hi) + '"></div>';
  }
  function fmtBound(v) { return Math.abs(v) >= 1000 ? U.formatQty(Math.round(v)) : (Math.round(v * 100) / 100).toString().replace('.', ','); }

  function quick(field, key, label, minVal) {
    var on2 = field === 'qty' && +state.qtyMin === minVal && minVal !== '' && state.qtyMax === '';
    if (key === 'zero') on2 = state.qtyMin === '0' && state.qtyMax === '0';
    return '<button data-quick="' + field + ':' + key + '" data-min="' + (minVal === '' ? '' : minVal) + '"' + (on2 ? ' class="is-on"' : '') + '>' + label + '</button>';
  }

  function wireFacets() {
    $$('#facets .facet-head').forEach(function (h) {
      on(h, 'click', function () {
        var key = h.parentNode.dataset.facet;
        state.facetClosed[key] = !state.facetClosed[key];
        h.parentNode.classList.toggle('closed', !!state.facetClosed[key]);
      });
    });
    $$('#facets input[data-field]').forEach(function (inp) {
      on(inp, 'change', function () {
        var field = inp.dataset.field === 'color' ? 'colors' : inp.dataset.field === 'wh' ? 'wh' : inp.dataset.field;
        var arr = state[field];
        var v = inp.dataset.value;
        var i = arr.indexOf(v);
        if (inp.checked) { if (i < 0) arr.push(v); } else if (i >= 0) arr.splice(i, 1);
        refresh();
      });
    });
    $$('#facets [data-clear]').forEach(function (b) {
      on(b, 'click', function () {
        var f = b.dataset.clear === 'color' ? 'colors' : b.dataset.clear;
        state[f] = []; refresh();
      });
    });
    $$('#facets [data-only]').forEach(function (b) {
      on(b, 'click', function () {
        var f = b.dataset.only === 'color' ? 'colors' : b.dataset.only;
        var arr = (state.filtered && state.filtered.facets[f === 'colors' ? 'color' : f]) || {};
        state[f] = Object.keys(arr).filter(function (k) { return arr[k] > 0 && k !== ''; });
        refresh();
      });
    });
    $$('#facets [data-more]').forEach(function (b) {
      on(b, 'click', function () { state.colorLimit = 100000; renderFacets(); });
    });
    $$('#facets input[data-range]').forEach(function (inp) {
      on(inp, 'input', U.debounce(function () {
        state[inp.dataset.range + (inp.dataset.edge === 'min' ? 'Min' : 'Max')] = inp.value === '' ? '' : String(inp.value).replace(',', '.');
        refresh();
      }, 260));
    });
    $$('#facets [data-quick]').forEach(function (b) {
      on(b, 'click', function () {
        var parts = b.dataset.quick.split(':');
        if (parts[1] === 'zero') { state.qtyMin = '0'; state.qtyMax = '0'; }
        else if (state.qtyMin === b.dataset.min) { state.qtyMin = ''; }
        else { state.qtyMin = b.dataset.min; state.qtyMax = ''; }
        refresh();
      });
    });
    var cf = $('#color-filter-input');
    if (cf) {
      on(cf, 'input', U.debounce(function () { state.colorFilterText = cf.value; renderFacets(); var n = $('#color-filter-input'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 180));
    }
  }

  /* ---------- сетка: клики, клавиши ---------- */
  function onGridClick(e) {
    var tr = e.target.closest ? e.target.closest('tr[data-i], tr.grp') : null;
    if (!tr) return;
    if (tr.dataset.g !== undefined) {
      var g = state.groups[+tr.dataset.g];
      state.expanded[g.key] = !state.expanded[g.key];
      flattenGroups(); renderBody();
      return;
    }
    var i = +tr.dataset.i;
    if (e.ctrlKey || e.metaKey) {
      var r = state.ds.rows[i];
      if (r.c) { toggleIn(state.colors, U.norm(r.c)); return; }
    }
    state.sel = i;
    $$('tr.is-sel', els['tbody']).forEach(function (x) { x.classList.remove('is-sel'); });
    tr.classList.add('is-sel');
    renderDetail(i);
  }

  function onHeadClick(e) {
    var th = e.target.closest ? e.target.closest('th[data-sort]') : null;
    if (!th || th.classList.contains('nosort')) return;
    var key = th.dataset.sort;
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort = key; state.dir = key === 'qty' || key === 'price' ? 'desc' : 'asc'; }
    if (key === 'idx') { state.sort = 'default'; state.dir = 'asc'; }
    if (['relevance', 'default', 'name', 'qty', 'char', 'price'].indexOf(state.sort) >= 0) els['sort-select'].value = state.sort;
    refresh();
  }

  function onKeys(e) {
    var inField = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ''));
    if (e.key === '/' && !inField) { e.preventDefault(); els['q'].focus(); els['q'].select(); return; }
    if (e.key === 'Escape') {
      if ($('.backdrop')) { closeModal(); e.preventDefault(); return; }
      if (!els['detail'].hidden) { closeDetail(); return; }
      if (inField && e.target === els['q'] && state.q) { els['q'].value = ''; state.q = ''; state.query = S.parseQuery(''); refresh({ soft: true }); }
      return;
    }
    if (inField && e.target !== document.body) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); els['q'].focus(); els['q'].select(); return; }
    if (e.altKey && e.key.toLowerCase() === 'r') { e.preventDefault(); manualRefresh(); return; }
    if (e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); els['sidebar'].classList.toggle('open'); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') && state.viewRows.length) {
      e.preventDefault();
      var step = e.key === 'PageDown' ? 15 : e.key === 'PageUp' ? -15 : (e.key === 'ArrowDown' ? 1 : -1);
      var pos = -1;
      for (var i = 0; i < state.viewRows.length; i++) if (state.viewRows[i].i === state.sel) { pos = i; break; }
      pos = U.clamp((pos < 0 ? 0 : pos + step), 0, state.viewRows.length - 1);
      var vr = state.viewRows[pos];
      if (vr.t !== 'g') {
        state.sel = vr.i;
        var want = pos * ROW_H;
        if (want < els['scroller'].scrollTop || want + ROW_H > els['scroller'].scrollTop + els['scroller'].clientHeight - 40) {
          els['scroller'].scrollTop = Math.max(0, want - els['scroller'].clientHeight / 2);
        }
        renderBody(); renderDetail(vr.i);
      }
    }
  }

  /* ---------- детальная панель ---------- */
  function closeDetail() { els['detail'].hidden = true; state.sel = -1; $$('tr.is-sel', els['tbody']).forEach(function (x) { x.classList.remove('is-sel'); }); }

  function renderDetail(i) {
    var r = state.ds.rows[i];
    if (!r) { closeDetail(); return; }
    els['detail'].hidden = false;
    els['detail-title'].innerHTML = U.highlight(r.n, tokensOf(state.query)) || 'Позиция';
    var low = +state.lowStock;
    var pill = r.q < 0 ? 'neg' : r.q <= 0 ? 'zero' : r.q <= low ? 'low' : 'pos';
    var html = '<div class="big-qty">' + U.formatQty(r.q) + '<small>шт ' + ({ pos: 'в наличии', low: 'мало', zero: 'нет', neg: 'минус' })[pill] + '</small></div>';
    html += '<dl class="dl">';
    html += '<dt>Характеристика</dt><dd>' + (r.c ? '<span class="dotc" style="--dot:' + colorHex(r.c) + '"></span>' + U.escapeHtml(r.c) : '—') + '</dd>';
    if (r.sku) html += '<dt>Артикул</dt><dd class="mono">' + U.escapeHtml(r.sku) + '</dd>';
    if (r.w) html += '<dt>Склад</dt><dd>' + U.escapeHtml(r.w) + '</dd>';
    if (r.p !== null && r.p !== undefined) html += '<dt>Цена</dt><dd>' + U.formatMoney(r.p) + '</dd>';
    if (r.qr && r.qr !== String(r.q)) html += '<dt>В файле</dt><dd class="mono">' + U.escapeHtml(r.qr) + '</dd>';
    var cols = state.ds.columns.filter(function (c) { return c.extra; });
    for (var x = 0; x < cols.length; x++) {
      var v = r.x ? r.x[cols[x].pos] : '';
      if (v) html += '<dt>' + U.escapeHtml(cols[x].label) + '</dt><dd>' + U.escapeHtml(v) + '</dd>';
    }
    html += '<dt>Строка&nbsp;файла</dt><dd class="mono">' + (i + 1 + (state.headerRow >= 0 ? state.headerRow + 1 : 0)) + '</dd>';
    html += '</dl>';
    var sibs = [];
    for (var k = 0; k < state.ds.rows.length; k++) if (state.ds.rows[k].g === r.g && k !== i) sibs.push(k);
    if (sibs.length > 60) sibs = sibs.slice(0, 60);
    if (sibs.length) {
      html += '<div class="dsec">Другие варианты позиции · ' + sibs.length + '</div>';
      html += sibs.map(function (j) {
        var s = state.ds.rows[j];
        var sp = s.q < 0 ? 'neg' : s.q <= 0 ? 'zero' : s.q <= low ? 'low' : 'pos';
        return '<div class="sib' + (j === i ? ' is-cur' : '') + '" data-jump="' + j + '">' +
          (s.c ? '<span class="dotc" style="--dot:' + colorHex(s.c) + ';margin:0"></span>' : '') +
          '<span>' + U.escapeHtml(s.c || s.w || '—') + '</span>' +
          (s.w ? '<span class="grp-colors">' + U.escapeHtml(s.w) + '</span>' : '') +
          '<span class="q pill pill-' + sp + '">' + U.formatQty(s.q) + '</span></div>';
      }).join('');
    }
    html += '<div class="f-op" style="margin-top:14px">' +
      '<button data-d="find">' + 'Искать название' + '</button>' +
      (r.c ? '<button data-d="color">Фильтр по цвету</button>' : '') +
      '<button data-d="copy">Скопировать</button></div>';
    els['detail-body'].innerHTML = html;
    $$('#detail-body [data-jump]').forEach(function (b) { on(b, 'click', function () { var j = +b.dataset.jump; state.sel = j; renderBody(); renderDetail(j); scrollToRow(j); }); });
    $$('#detail-body [data-d]').forEach(function (b) {
      on(b, 'click', function () {
        if (b.dataset.d === 'find') { els['q'].value = r.n; state.q = r.n; state.query = S.parseQuery(r.n); els['q-clear'].hidden = false; refresh(); }
        else if (b.dataset.d === 'color') { toggleIn(state.colors, U.norm(r.c)); }
        else { copyText([r.n, r.c, r.sku, r.q].filter(Boolean).join('\t')); }
      });
    });
  }

  function scrollToRow(i) {
    for (var k = 0; k < state.viewRows.length; k++) if (state.viewRows[k].i === i) {
      var want = k * ROW_H;
      els['scroller'].scrollTop = U.clamp(want - els['scroller'].clientHeight / 2, 0, state.ds.rows.length * ROW_H);
      return;
    }
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast('Скопировано в буфер обмена'); }, function () { legacyCopy(t); });
    } else legacyCopy(t);
  }
  function legacyCopy(t) {
    var ta = U.el('textarea', { text: t, style: 'position:fixed;left:-9999px' });
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать', 'err'); }
    ta.remove();
  }

  /* ==================== импорт/обновление ==================== */
  function toggleRefreshUI() {
    els['btn-refresh'].hidden = !state.hasHandle;
    els['btn-auto'].hidden = !state.hasHandle;
    els['btn-auto'].classList.toggle('is-on', !!state.autoMin);
    els['btn-auto'].querySelector('.btn-lbl').textContent = state.autoMin ? 'Авто ' + state.autoMin + ' мин' : 'Авто';
  }

  function manualRefresh(silent) {
    if (!state.hasHandle) { pickViaInput(); return Promise.resolve(); }
    setBusy(silent ? 'Проверяю файл…' : 'Перечитываю файл…', -1);
    var keepHandle = null;
    return FS.loadHandle('current').then(function (h) {
      if (!h) throw new Error('Файл больше не доступен — выберите его заново');
      keepHandle = h;
      return FS.readFile(h);
    }).then(function (r) {
      if (silent && r.mtime && r.mtime === state.fileMtime) { setBusy('', 0); return null; }
      return ingest(r.buffer, { fileName: r.name, fileSize: r.size, fileMtime: r.mtime, fresh: false, handle: keepHandle });
    }).catch(function (e) {
      setBusy('', 0);
      var msg = errText(e);
      if (!silent) toast(msg, 'err');
      else if (/разрешени|denied|prompt/i.test(msg)) {
        stopAuto();
        toast('Автообновление приостановлено: браузеру нужно заново разрешить чтение файла', 'warn', { label: 'Разрешить', fn: function () { manualRefresh(); } });
      }
      return null;
    });
  }

  function startAuto() {
    stopAuto();
    if (!state.autoMin || !state.hasHandle) return;
    autoTimer = setInterval(function () { if (!document.hidden) manualRefresh(true); }, Math.max(1, state.autoMin) * 60000);
    toast('Автообновление каждые ' + state.autoMin + ' мин — пока вкладка открыта');
  }
  function stopAuto() { if (autoTimer) clearInterval(autoTimer); autoTimer = 0; }
  function restartAuto() { if (state.autoMin && state.hasHandle) startAuto(); else stopAuto(); toggleRefreshUI(); }

  function loadDemo() {
    var data = root.OST_DEMO;
    if (!data) { toast('Демо-данные не найдены', 'err'); return; }
    var ws = XLSX.utils.aoa_to_sheet(data);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Прайс Ника');
    var out;
    try { out = XLSX.write(wb, { bookType: 'biff8', type: 'array' }); }
    catch (e) { out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }); }
    state.datasetId = U.uid('demo');
    state.sheetName = '';
    state.mapping = null;
    var buf = out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer;
    ingest(buf, { fileName: 'Демо — Ника 41 (полотенцесушители).xls', fileSize: buf.byteLength, fileMtime: Date.now(), fresh: true }).catch(function () { });
  }

  /* ==================== перенастройка колонок ==================== */
  function openRemap(forced) {
    if (!state.book && !state.aoa) { toast('Нет исходных данных листа — загрузите файл заново', 'warn'); return; }
    var sheets = state.book ? state.book.sheets : [{ name: state.sheetName, aoa: state.aoa }];
    var cur = {
      sheet: state.sheetName,
      headerRow: state.headerRow,
      mapping: cloneMapping(state.mapping || { name: -1, char: -1, qty: -1, sku: -1, price: -1, warehouse: -1, unit: -1, min: -1, extra: [] })
    };
    var body = document.createElement('div');
    body.innerHTML =
      '<p style="margin:.2rem 0 .8rem;color:var(--txt-2)">' + (forced
        ? 'Не удалось уверенно распознать таблицу. Укажите строку заголовка и колонки — остальное приложение пересчитает само.'
        : 'Проверьте, правильно ли определены колонки прайса. Изменения применяются к загруженному файлу мгновенно.') + '</p>' +
      '<div class="grid2" id="rm-row1"></div>' +
      '<div class="sectitle">Соответствие колонок</div>' +
      '<div class="grid2" id="rm-map"></div>' +
      '<label class="chk" style="margin-top:10px"><input type="checkbox" id="rm-reuse" ' + (state.reuseConfig ? 'checked' : '') + '> Запомнить эти настройки для этого файла (и для автообновления)</label>' +
      '<div class="sectitle">Предпросмотр первых строк</div>' +
      '<div class="preview" id="rm-preview"></div>';
    var m = modal({
      title: 'Настройка колонок ' + (state.fileName ? '· ' + U.escapeHtml(state.fileName) : ''),
      body: body,
      width: 900,
      buttons: [
        { label: state.backup ? 'Вернуть прежний прайс' : 'Отмена', fn: function () { if (!restoreBackup()) closeModal(); else closeModal(); } },
        {
          label: 'Применить', primary: true, fn: function () {
            state.reuseConfig = $('#rm-reuse').checked;
            applyRemap(cur);
            closeModal();
          }
        }
      ]
    });
    function fieldSel(id, label, options, value, hint) {
      return '<div class="field"><label>' + label + '</label><select id="' + id + '">' +
        options.map(function (o) { return '<option value="' + o.v + '"' + (String(o.v) === String(value) ? ' selected' : '') + '>' + U.escapeHtml(o.t) + '</option>'; }).join('') +
        '</select>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
    }
    function draw() {
      var sheet = sheets.filter(function (s) { return s.name === cur.sheet; })[0] || sheets[0];
      cur.sheet = sheet.name;
      var aoa = sheet.aoa;
      var headerCandidates = [{ v: -1, t: '— шапки нет —' }];
      for (var r = 0; r < Math.min(aoa.length, 25); r++) {
        var t = aoa[r].map(P.cellText).filter(Boolean).join(' | ').slice(0, 88);
        headerCandidates.push({ v: r, t: 'строка ' + (r + 1) + ': ' + (t || '…') });
      }
      $('#rm-row1').innerHTML =
        fieldSel('rm-sheet', 'Лист', sheets.map(function (s) { return { v: s.name, t: s.name + ' (' + s.aoa.length + ' строк)' }; }), cur.sheet) +
        fieldSel('rm-header', 'Строка заголовка', headerCandidates, cur.headerRow, 'обычно 1-я строка с названиями колонок');
      var headers = cur.headerRow >= 0 ? (aoa[cur.headerRow] || []).map(P.cellText) : [];
      var maxCols = 0;
      for (var i = 0; i < Math.min(aoa.length, 60); i++) maxCols = Math.max(maxCols, (aoa[i] || []).length);
      for (var g = headers.length; g < maxCols; g++) headers[g] = headers[g] || '';
      var colOpts = [{ v: -1, t: '— не использовать —' }].concat(headers.map(function (h, i) {
        return { v: i, t: 'Кол. ' + (i + 1) + ': ' + (h || '(пусто) ' + P.cellText((aoa[cur.headerRow + 1] || [])[i])) };
      }));
      var mapDefs = [['name', 'Номенклатура'], ['char', 'Характеристика (цвет)'], ['qty', 'Остаток'], ['sku', 'Артикул'], ['price', 'Цена'], ['warehouse', 'Склад']];
      $('#rm-map').innerHTML = mapDefs.map(function (d) { return fieldSel('rm-' + d[0], d[1], colOpts, cur.mapping[d[0]]); }).join('');
      // превью
      var usedCols = [];
      var map2 = {};
      mapDefs.forEach(function (d) { map2[d[0]] = +$('#rm-' + d[0]).value; if (map2[d[0]] >= 0) usedCols.push(map2[d[0]]); });
      var from = cur.headerRow + 1;
      var html = '<table><thead><tr><th></th>';
      for (var c = 0; c < maxCols; c++) html += '<th>К' + (c + 1) + '</th>';
      html += '</tr></thead><tbody>';
      for (var rr = 0; rr < Math.min(aoa.length, from + 14); rr++) {
        var isHdr = rr === cur.headerRow;
        html += '<tr class="' + (isHdr ? 'is-hdr' : '') + '"><th>' + (rr + 1) + '</th>';
        for (var cc = 0; cc < maxCols; cc++) {
          var mapped = usedCols.indexOf(cc) >= 0;
          html += (isHdr ? '<th class="' + (mapped ? 'is-map' : '') + '">' : '<td class="' + (mapped ? 'is-map' : '') + '">') + U.escapeHtml(P.cellText((aoa[rr] || [])[cc]).slice(0, 42)) + (isHdr ? '</th>' : '</td>');
        }
        html += '</tr>';
      }
      $('#rm-preview').innerHTML = html + '</tbody></table>';
      $('#rm-sheet').onchange = function () { cur.sheet = this.value; draw(); };
      $('#rm-header').onchange = function () {
        cur.headerRow = +this.value;
        var m2 = P.detectMapping(headersFrom(cur.headerRow), aoa, cur.headerRow);
        mapDefs.forEach(function (d) { if (m2[d[0]] >= 0) cur.mapping[d[0]] = m2[d[0]]; });
        draw();
      };
      mapDefs.forEach(function (d) { $('#rm-' + d[0]).onchange = function () { cur.mapping[d[0]] = +this.value; draw(); }; });
      function headersFrom(hr) { return hr >= 0 ? (aoa[hr] || []).map(P.cellText) : []; }
      cur.mapDefs = mapDefs;
      cur.headers = headers;
      cur.aoa = aoa;
    }
    draw();
    return m;
  }

  function applyRemap(cur) {
    var sheet = (state.book ? state.book.sheets : [{ name: cur.sheet, aoa: cur.aoa }]).filter(function (s) { return s.name === cur.sheet; })[0];
    if (!sheet) { toast('Лист не найден', 'err'); return; }
    var mapping = cloneMapping(cur.mapping);
    var used = {};
    cur.mapDefs.forEach(function (d) { if (mapping[d[0]] >= 0) used[mapping[d[0]]] = 1; });
    var extras = [];
    var maxCols = 0;
    for (var i = 0; i < Math.min(sheet.aoa.length, 400); i++) maxCols = Math.max(maxCols, (sheet.aoa[i] || []).length);
    for (var c = 0; c < maxCols; c++) if (!used[c]) {
      var has = false;
      for (var r = cur.headerRow + 1; r < Math.min(sheet.aoa.length, cur.headerRow + 40); r++) if (P.cellText((sheet.aoa[r] || [])[c])) { has = true; break; }
      if (has) extras.push(c);
    }
    mapping.extra = extras;
    var ds = P.buildDataset({
      aoa: sheet.aoa, headers: cur.headers, headerRow: cur.headerRow, mapping: mapping,
      fileName: state.fileName, fileSize: state.ds ? state.ds.fileSize : 0, fileMtime: state.fileMtime,
      sheetName: sheet.name, id: state.datasetId
    });
    if (!ds.rows.length) {
      toast('После применения настроек не осталось ни одной строки — проверьте выбор колонок', 'err');
      return;
    }
    state.sheetName = sheet.name;
    state.backup = null;
    adoptDataset(ds, { keepFilters: true });
    ST.saveDataset(ds, null).then(function () { return ST.saveState({ datasetId: ds.id, fileName: ds.fileName, at: Date.now() }); })
      .then(refreshList).catch(function () { });
    toast('Колонки применены: ' + U.formatQty(ds.stats.rows) + ' строк');
  }

  /* ==================== экспорт ==================== */
  function exportAoa(withGroups) {
    var head = ['№', 'Номенклатура', 'Характеристика (цвет)', 'Остаток'];
    var ds = state.ds;
    var cols = state.ds.columns;
    var keys = [];
    cols.forEach(function (c) {
      if (c.key === 'price') { head.push(c.label); keys.push('price'); }
      else if (c.key === 'sku') { head.push(c.label); keys.push('sku'); }
      else if (c.key === 'warehouse') { head.push(c.label); keys.push('warehouse'); }
      else if (c.key === 'min') { head.push(c.label); keys.push('min'); }
      else if (c.extra) { head.push(c.label); keys.push(c.key); }
    });
    var out = [head];
    var ids = withGroups ? state.order : state.order;
    for (var n = 0; n < ids.length; n++) {
      var r = ds.rows[ids[n]];
      var row = [ids[n] + 1, r.n, r.c, r.q];
      keys.forEach(function (k) {
        if (k === 'price') row.push(r.p === null || r.p === undefined ? '' : r.p);
        else if (k === 'sku') row.push(r.sku);
        else if (k === 'warehouse') row.push(r.w);
        else if (k === 'min') row.push('');
        else row.push(r.x && k.slice(0, 1) === 'x' ? r.x[+k.slice(1)] : '');
      });
      out.push(row);
    }
    return out;
  }

  function openExport() {
    if (!state.ds) return;
    var body = document.createElement('div');
    var n = state.order.length;
    body.innerHTML =
      '<div class="grid2">' +
      '<div class="field"><label>Что выгружать</label><select id="ex-what"><option value=\"filtered\">Отфильтрованное (' + n + ' строк)</option><option value="all">Весь прайс (' + state.ds.stats.rows + ' строк)</option></select></div>' +
      '<div class="field"><label>Формат</label><select id="ex-fmt"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV («;» для Excel)</option><option value="tsv">TSV (для вставки в Excel)</option><option value="json">JSON</option></select></div>' +
      '</div>' +
      '<div class="sectitle">Действия</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn" data-x="copy">Скопировать в буфер</button>' +
      '<button class="btn" data-x="print">Печать / PDF</button>' +
      '<button class="btn" data-x="link">Ссылка на текущую выборку</button>' +
      '</div>';
    modal({
      title: 'Экспорт прайса', body: body, width: 640,
      buttons: [{ label: 'Закрыть', fn: closeModal }, {
        label: 'Скачать', primary: true, fn: function () {
          var what = $('#ex-what').value, fmt = $('#ex-fmt').value;
          var keep = state.order;
          if (what === 'all') state.order = state.ds.rows.map(function (_, i) { return i; });
          var aoa = exportAoa();
          state.order = keep;
          doExport(fmt, aoa);
          closeModal();
        }
      }]
    });
    $$('#modal-root [data-x]').forEach(function (b) {
      on(b, 'click', function () {
        var aoa = exportAoa();
        if (b.dataset.x === 'copy') copyText(aoa.map(function (r) { return r.join('\t'); }).join('\n'));
        else if (b.dataset.x === 'print') window.print();
        else { copyText(writeHash(true)); toast('Ссылка скопирована — фильтры зашиты в неё'); }
      });
    });
  }

  function doExport(fmt, aoa) {
    var base = (state.fileName || 'price').replace(/\.[^.]+$/, '');
    var stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'csv') {
      var csv = '\ufeff' + aoa.map(function (r) {
        return r.map(function (c) {
          var s = c === null || c === undefined ? '' : String(c).replace(/"/g, '""');
          return /[";\n]/.test(s) ? '"' + s + '"' : s;
        }).join(';');
      }).join('\r\n');
      U.download(base + '_' + stamp + '.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    } else if (fmt === 'tsv') {
      U.download(base + '_' + stamp + '.tsv', new Blob([aoa.map(function (r) { return r.join('\t'); }).join('\r\n')], { type: 'text/plain;charset=utf-8' }));
    } else if (fmt === 'json') {
      U.download(base + '_' + stamp + '.json', new Blob([JSON.stringify({ exportedAt: Date.now(), source: state.fileName, rows: aoa }, null, 1)], { type: 'application/json' }));
    } else {
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 54 }, { wch: 24 }, { wch: 10 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Остатки');
      try { XLSX.writeFile(wb, base + '_' + stamp + '.xlsx'); }
      catch (e) { toast('Не удалось записать xlsx: ' + errText(e), 'err'); }
    }
    toast('Выгружено строк: ' + (aoa.length - 1));
  }

  /* ==================== ссылка / hash ==================== */
  function writeHash(forText) {
    var p = [];
    if (state.q) p.push('q=' + encodeURIComponent(state.q));
    if (state.colors.length) p.push('color=' + encodeURIComponent(state.colors.join('|')));
    if (state.wh.length) p.push('wh=' + encodeURIComponent(state.wh.join('|')));
    if (state.stock.length) p.push('stock=' + state.stock.join('|'));
    if (state.qtyMin !== '' || state.qtyMax !== '') p.push('qty=' + state.qtyMin + '-' + state.qtyMax);
    if (state.priceMin !== '' || state.priceMax !== '') p.push('price=' + state.priceMin + '-' + state.priceMax);
    if (state.view !== 'table') p.push('view=' + state.view);
    if (state.sort !== 'relevance') p.push('sort=' + state.sort + (state.dir === 'desc' ? '-desc' : ''));
    if (state.datasetId) p.push('ds=' + state.datasetId);
    var h = p.length ? '#' + p.join('&') : '';
    if (forText) return root.location.href.split('#')[0] + h;
    try { history.replaceState(null, '', root.location.pathname + root.location.search + h); } catch (e) { }
    return h;
  }

  function readHash(applyNow) {
    var h = (root.location.hash || '').replace(/^#/, '');
    var out = {};
    if (!h) return out;
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    if (!applyNow) return out;
    var changed = false;
    if (out.q && out.q !== state.q) { els['q'].value = out.q; state.q = out.q; changed = true; }
    if (out.color) { state.colors = out.color.split('|').filter(Boolean); changed = true; }
    if (out.wh) { state.wh = out.wh.split('|').filter(Boolean); changed = true; }
    if (out.stock) { state.stock = out.stock.split('|').filter(Boolean); changed = true; }
    if (out.qty) { var a = out.qty.split('-'); state.qtyMin = a[0] || ''; state.qtyMax = a[1] || ''; changed = true; }
    if (out.price) { var b = out.price.split('-'); state.priceMin = b[0] || ''; state.priceMax = b[1] || ''; changed = true; }
    if (out.view) { state.view = out.view; changed = true; $$('#view-toggle .seg-btn').forEach(function (b) { b.classList.toggle('is-on', b.dataset.view === state.view); }); }
    if (out.sort) { state.sort = out.sort.replace(/-desc$/, ''); state.dir = /-desc$/.test(out.sort) ? 'desc' : 'asc'; changed = true; }
    if (changed && state.ds) { state.query = S.parseQuery(state.q); refresh(); }
    return out;
  }

  /* ---------- запросы из попапа / горячих клавиш ---------- */
  function applyOpenRequest(req) {
    if (!req) return;
    try { if (root.chrome && chrome.storage && chrome.storage.local) chrome.storage.local.remove('openRequest'); } catch (e) { }
    if (req.q) {
      els['q'].value = req.q; state.q = req.q; state.query = S.parseQuery(req.q);
      els['q-clear'].hidden = false;
      refresh({ soft: true });
      els['q'].focus(); els['q'].select();
    }
    if (req.action === 'import') { setTimeout(pickViaInput, 60); }
    else if (req.action === 'refresh') { setTimeout(function () { manualRefresh(); }, 60); }
    else if (req.action === 'focus') { els['q'].focus(); els['q'].select(); }
  }

  function consumeOpenRequest() {
    var params = new URLSearchParams(root.location.search || '');
    var viaUrl = {};
    if (params.get('q')) viaUrl.q = params.get('q');
    if (params.get('focus')) viaUrl.action = 'focus';
    if (params.get('import')) viaUrl.action = 'import';
    if (params.get('refresh')) viaUrl.action = 'refresh';
    if (viaUrl.q || viaUrl.action) applyOpenRequest(viaUrl);
    try {
      if (root.chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['openRequest'], function (r) { if (r && r.openRequest) applyOpenRequest(r.openRequest); });
      }
    } catch (e) { }
  }

  /* ==================== служебное ==================== */
  function setBusy(text, frac) {
    els['stat-progress'].innerHTML = text || '';
    els['loadbar'].hidden = !text;
    if (text) els['loadbar'].value = frac === -1 ? 0.02 : frac;
  }
  function showEmpty(msg) {
    document.body.classList.remove('has-data');
    if (msg) toast(msg, 'warn');
  }
  function toast(html, kind, action) {
    var t = U.el('div', { class: 'toast ' + (kind || '') });
    t.innerHTML = html;
    if (action) {
      var b = U.el('button', { text: action.label });
      b.addEventListener('click', function () { action.fn(); t.remove(); });
      t.appendChild(b);
    }
    els['toasts'].appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, action ? 9000 : 4200);
  }

  function updateBadge() {
    var n = state.filtered ? state.filtered.agg.matched : (state.ds ? state.ds.stats.rows : 0);
    try {
      if (root.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'badge', text: n > 999 ? Math.round(n / 1000) + 'k' : String(n) }, function () { void (chrome.runtime.lastError); });
      }
    } catch (e) { }
  }

  function switchDataset(id) {
    if (!id) return;
    ST.loadDataset(id).then(function (ds) {
      if (!ds) { toast('Не удалось загрузить прайс', 'err'); return; }
      state.book = null; state.aoa = null; state.sheetName = ds.sheetName;
      state.fileName = ds.fileName; state.fileMtime = ds.fileMtime || 0;
      state.datasetId = ds.id;
      adoptDataset(ds, {});
      refreshList();
    });
  }

  function refreshList() {
    return ST.listDatasets().then(function (list) {
      if (!list.length) { els['ds-switch'].hidden = true; return; }
      els['ds-switch'].hidden = false;
      els['ds-switch'].innerHTML = list.map(function (m) {
        return '<option value="' + m.id + '"' + (m.id === state.datasetId ? ' selected' : '') + '>' +
          U.escapeHtml((m.fileName || 'прайс').replace(/\.[^.]+$/, '')) + ' · ' + (m.importedAt ? new Date(m.importedAt).toLocaleDateString('ru-RU') : '') + ' · ' + U.formatQty(m.stats ? m.stats.rows : 0) + ' стр.' +
          '</option>';
      }).join('') + '<option value="__del">🗑 Удалить текущий</option>';
      els['ds-switch'].value = state.datasetId || list[0].id;
    });
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
    document.documentElement.setAttribute('data-theme', state.theme);
    saveSettings();
    toast('Тема: ' + ({ auto: 'как в системе', light: 'светлая', dark: 'тёмная' })[state.theme]);
  }

  /* ---------- модалки ---------- */
  function modal(o) {
    closeModal();
    var back = U.el('div', { class: 'backdrop' });
    var box = U.el('div', { class: 'modal' });
    if (o.width) box.style.width = 'min(' + o.width + 'px, 100%)';
    box.innerHTML = '<div class="modal-head"><h2>' + o.title + '</h2><button class="btn btn-icon" data-close>✕</button></div>' +
      '<div class="modal-body"></div>' +
      '<div class="modal-foot"></div>';
    $('.modal-body', box).appendChild(o.body);
    var foot = $('.modal-foot', box);
    (o.buttons || []).forEach(function (b) {
      var btn = U.el('button', { class: 'btn' + (b.primary ? ' btn-primary' : ''), text: b.label });
      btn.addEventListener('click', b.fn);
      foot.appendChild(btn);
    });
    $('[data-close]', box).addEventListener('click', closeModal);
    back.addEventListener('mousedown', function (e) { if (e.target === back) closeModal(); });
    back.appendChild(box);
    els['modal-root'].appendChild(back);
    setTimeout(function () { var f = $('input,select,button.btn-primary', box); if (f) f.focus(); }, 30);
    return box;
  }
  function closeModal() { els['modal-root'].innerHTML = ''; }

  function openSettings(tab) {
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="grid2">' +
      '<div class="field"><label>Порог «мало»</label><input id="set-low" type="number" min="0" value="' + state.lowStock + '"><span class="hint">остаток до этого значения включительно подсвечивается жёлтым и попадает в фильтр «мало»</span></div>' +
      '<div class="field"><label>Плотность строк</label><select id="set-density"><option value="compact"' + (state.density === 'compact' ? ' selected' : '') + '>Плотная (30 px)</option><option value="comfortable"' + (state.density === 'comfortable' ? ' selected' : '') + '>Просторная (40 px)</option></select></div>' +
      '<div class="field"><label>Вид по умолчанию</label><select id="set-view"><option value="table"' + (state.view === 'table' ? ' selected' : '') + '>Позиции</option><option value="groups"' + (state.view === 'groups' ? ' selected' : '') + '>Спецификации</option></select></div>' +
      '<div class="field"><label>Автообновление файла</label><select id="set-auto">' + [0, 5, 10, 15, 30, 60].map(function (m) { return '<option value="' + m + '"' + (+state.autoMin === m ? ' selected' : '') + '>' + (m ? 'каждые ' + m + ' мин' : 'выключено') + '</option>'; }).join('') + '</select><span class="hint">' + (state.hasHandle ? 'работает для файла, выбранного через «Импорт XLS»' : 'сначала выберите файл через «Импорт XLS» (не перетаскиванием) — тогда Chrome запомнит доступ') + '</span></div>' +
      '<div class="field"><label>Цвета в фильтре</label><input id="set-colorlimit" type="number" min="5" max="500" value="' + state.colorLimit + '"><span class="hint">сколько значений показывать до кнопки «показать все»</span></div>' +
      '<div class="field"><label>Тема</label><select id="set-theme">' + [['auto', 'как в системе'], ['light', 'светлая'], ['dark', 'тёмная']].map(function (t) { return '<option value="' + t[0] + '"' + (state.theme === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></div>' +
      '</div>' +
      '<label class="chk" style="margin-top:12px"><input type="checkbox" id="set-reuse"' + (state.reuseConfig ? ' checked' : '') + '> Помнить разбивку по колонкам при обновлении того же файла</label>' +
      '<div class="sectitle">Хранилище</div>' +
      '<div id="set-store-info" class="hint" style="margin-bottom:8px"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn" id="set-save">Сохранить прайс в браузере</button>' +
      '<button class="btn" id="set-reload">Перечитать файл сейчас</button>' +
      '<button class="btn" id="set-clear" style="color:var(--bad);border-color:var(--bad)">Очистить всё сохранённое</button>' +
      '</div>';
    var m = modal({
      title: 'Настройки', body: body, width: 760,
      buttons: [
        { label: 'Закрыть', fn: closeModal },
        {
          label: 'Применить', primary: true, fn: function () {
            state.lowStock = +$('#set-low').value || 0;
            state.density = $('#set-density').value;
            state.view = $('#set-view').value;
            state.autoMin = +$('#set-auto').value;
            state.colorLimit = +$('#set-colorlimit').value || 28;
            state.theme = $('#set-theme').value;
            state.reuseConfig = $('#set-reuse').checked;
            document.documentElement.setAttribute('data-density', state.density);
            document.documentElement.setAttribute('data-theme', state.theme);
            $$('#view-toggle .seg-btn').forEach(function (b) { b.classList.toggle('is-on', b.dataset.view === state.view); });
            syncRowH(); saveSettings(); restartAuto(); refresh(); closeModal();
          }
        }
      ]
    });
    $('#set-save').addEventListener('click', function () {
      if (!state.ds) return;
      ST.saveDataset(state.ds, null).then(function () { toast('Прайс сохранён — откроется сам при следующем запуске'); refreshList(); });
    });
    $('#set-reload').addEventListener('click', function () { closeModal(); manualRefresh(); });
    $('#set-clear').addEventListener('click', function () {
      if (!confirm('Удалить все сохранённые прайсы и настройки?')) return;
      ST.clearAll().then(function () { toast('Хранилище очищено'); refreshList(); });
    });
    ST.listDatasets().then(function (list) {
      $('#set-store-info').innerHTML = (ST.persistent() ? 'IndexedDB доступен' : 'IndexedDB недоступен (режим file://) — данные живут до закрытия вкладки') +
        ' · сохранено прайсов: <b>' + list.length + '</b>' + (state.ds ? ' · сейчас: <b>' + U.escapeHtml(state.ds.fileName) + '</b> (' + U.formatQty(state.ds.stats.rows) + ' строк)' : '');
    });
    return m;
  }

  /* старт */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.OSTApp = {
    state: state, refresh: refresh, ingest: ingest, toast: toast, exportAoa: exportAoa,
    renderBody: renderBody, openSettings: openSettings, openRemap: openRemap, manualRefresh: manualRefresh,
    loadDemo: loadDemo, writeHash: writeHash, readHash: readHash, colorHex: colorHex, columns: columns
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
