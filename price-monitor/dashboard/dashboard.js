/*
 * Панель «Монитора цен»: результаты в формате отчёта, редактор позиций, настройки, журнал.
 * Данные читаются из chrome.storage.local и обновляются вживую (storage.onChanged).
 */
'use strict';
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var S = { settings: PM.normalizeSettings({}), positions: [], results: {}, run: { state: 'idle', queue: [] }, log: [] };
  var draft = null, dirty = false, missingOrigins = [];

  function send(msg) {
    return chrome.runtime.sendMessage(msg).then(function (r) {
      if (r && r.ok === false && r.error) toast(r.error);
      return r;
    });
  }
  function toast(text) {
    var el = $('#status');
    el.dataset.toast = '1';
    el.innerHTML = '<b>' + esc(text) + '</b>';
    setTimeout(function () { delete el.dataset.toast; renderStatus(); }, 3500);
  }
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function stamp() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()); }

  /* ---------------- вкладки ---------------- */
  function showTab() {
    var name = (location.hash || '#results').slice(1);
    if (!$('#tab-' + name)) name = 'results';
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
  }
  window.addEventListener('hashchange', showTab);

  /* ---------------- статус и кнопки ---------------- */
  function rel(ts) {
    var ms = ts - Date.now();
    if (ms <= 0) return 'сейчас';
    var m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000);
    if (m >= 90) return PM.fmtTime(ts);
    return 'через ' + (m ? m + ' мин ' : '') + (m < 5 ? s + ' с' : '');
  }
  function renderStatus() {
    var el = $('#status');
    if (el.dataset.toast) return;
    var r = S.run, html;
    if (r.state === 'running') {
      html = 'Идёт круг: <b>' + (r.done || 0) + ' из ' + (r.total || 0) + '</b>';
      if (r.current) {
        var x = PM.findLink(S.positions, r.current.linkId);
        html += ' · проверяю <b>' + esc(x ? PM.hostOf(x.link.url) : '…') + '</b>';
      } else if (r.nextAt) html += ' · следующая проверка <b>' + rel(r.nextAt) + '</b>';
    } else if (r.state === 'paused') html = 'Пауза · в очереди ' + (r.queue || []).length;
    else if (r.state === 'waiting') html = 'Круг завершён · следующий <b>' + PM.fmtTime(r.nextAt) + '</b> (' + rel(r.nextAt) + ')';
    else html = 'Остановлено' + (r.lastCycleFinishedAt ? ' · последний круг ' + PM.fmtTime(r.lastCycleFinishedAt) : '');
    el.innerHTML = html;
    $('#btnStart').hidden = r.state === 'running' || r.state === 'paused';
    $('#btnStart').textContent = r.state === 'waiting' ? '▶ Проверить сейчас' : '▶ Старт';
    $('#btnPause').hidden = r.state !== 'running';
    $('#btnResume').hidden = r.state !== 'paused';
    $('#btnStop').hidden = r.state === 'idle';
  }
  setInterval(renderStatus, 1000);

  function enabledUrls(positions) {
    var urls = [];
    PM.allLinks(positions).forEach(function (x) { if (x.link.enabled && !PM.isExcluded(x.link.url, S.settings.excludedDomains)) urls.push(x.link.url); });
    return urls;
  }
  /** Запрос доступа к сайтам — обязательно прямо в обработчике клика (требование Chrome). */
  function requestAccess(urls) {
    var origins = PM.originPatterns(urls);
    if (!origins.length) return Promise.resolve(true);
    return chrome.permissions.request({ origins: origins }).catch(function () { return false; })
      .then(function (ok) { checkPermissions(); return ok; });
  }
  function checkPermissions() {
    var origins = PM.originPatterns(enabledUrls(S.positions));
    return Promise.all(origins.map(function (o) {
      return chrome.permissions.contains({ origins: [o] }).then(function (ok) { return ok ? null : o; });
    })).then(function (list) {
      missingOrigins = list.filter(Boolean);
      $('#permWarn').hidden = !missingOrigins.length;
      $('#permText').textContent = 'Нет разрешения открывать сайты: ' + missingOrigins.map(function (o) { return o.replace(/^\*:\/\/\*\.|\/\*$/g, ''); }).join(', ') + '. Без него цены с них не прочитать.';
    });
  }

  $('#btnStart').onclick = function () {
    requestAccess(enabledUrls(S.positions)).then(function () { return send({ type: 'start' }); });
  };
  $('#btnPause').onclick = function () { send({ type: 'pause' }); };
  $('#btnResume').onclick = function () { send({ type: 'resume' }); };
  $('#btnStop').onclick = function () { if (confirm('Остановить круг? Оставшаяся очередь будет сброшена, автоповтор выключится.')) send({ type: 'stop' }); };
  $('#btnPerm').onclick = function () { requestAccess(enabledUrls(S.positions)); };

  /* ---------------- результаты ---------------- */
  function renderResults() {
    var rows = PM.reportRows(S.positions, S.results, S.settings).filter(function (r) { return !r.excluded; });
    var onlyDump = $('#onlyDump').checked;
    var links = rows.filter(function (r) { return r.enabled; });
    var dumpRows = links.filter(function (r) { return r.dumping && r.status === 'ok'; });
    var dumpPos = {};
    dumpRows.forEach(function (r) { dumpPos[r.posId] = 1; });
    var checked = links.filter(function (r) { return r.checkedAt; });
    var lastCheck = checked.reduce(function (m, r) { return Math.max(m, r.checkedAt); }, 0);
    $('#summary').innerHTML =
      '<span>Позиций: <b>' + S.positions.length + '</b></span>' +
      '<span>Ссылок: <b>' + links.length + '</b></span>' +
      '<span class="' + (dumpRows.length ? 'bad' : '') + '">Демпинг: <b>' + dumpRows.length + '</b> ссыл. / <b>' + Object.keys(dumpPos).length + '</b> поз.</span>' +
      '<span>Круг ≈ <b>' + PM.fmtDuration(PM.estimateCycleMs(links.length, S.settings)) + '</b></span>' +
      '<span>Последняя проверка: <b>' + PM.fmtTime(lastCheck) + '</b></span>';

    var blocked = S.run.domainBlockedUntil || {}, now = Date.now();
    var paused = Object.keys(blocked).filter(function (d) { return blocked[d] > now; });
    $('#pauses').hidden = !paused.length;
    $('#pauses').innerHTML = paused.length ? 'Сайты на паузе (показали защиту от ботов): ' + paused.map(function (d) { return '<b>' + esc(d) + '</b> до ' + PM.fmtTime(blocked[d]); }).join(', ') + ' <button class="btn sm" id="btnResetPauses2">Сбросить</button>' : '';
    var rp = $('#btnResetPauses2'); if (rp) rp.onclick = function () { send({ type: 'resetSitePauses' }); };

    if (!S.positions.length) {
      $('#results').innerHTML = '<div class="empty">Позиций пока нет. Добавьте их на вкладке <a href="#positions">«Позиции и ссылки»</a>, импортируйте из Excel или загрузите пример.</div>';
      return;
    }
    var html = '';
    S.positions.forEach(function (p) {
      var pr = rows.filter(function (r) { return r.posId === p.id; });
      if (onlyDump) pr = pr.filter(function (r) { return r.dumping; });
      if (onlyDump && !pr.length) return;
      pr.sort(function (a, b) { return (a.price == null) - (b.price == null) || (a.price || 0) - (b.price || 0); });
      var prices = pr.filter(function (r) { return r.price != null && r.enabled; }).map(function (r) { return r.price; });
      var min = prices.length ? Math.min.apply(null, prices) : null;
      var nd = pr.filter(function (r) { return r.dumping && r.enabled; }).length;
      html += '<div class="pos"><div class="pos-h"><h3>' + esc(p.name || p.article) + '</h3>' +
        '<span class="meta">арт. <b>' + esc(p.article || '—') + '</b></span>' +
        '<span class="meta">наша цена <b>' + PM.fmtMoney(p.ourPrice) + '</b></span>' +
        (min != null ? '<span class="meta">мин. у конкурентов <b>' + PM.fmtMoney(min) + '</b> (' + PM.fmtPct(PM.deviation(min, p.ourPrice)) + ')</span>' : '') +
        (nd ? '<span class="pill bad">демпинг: ' + nd + '</span>' : (prices.length ? '<span class="pill ok">демпинга нет</span>' : '')) +
        '</div>';
      if (!pr.length) { html += '<div class="hint" style="padding:10px 14px">Нет ссылок конкурентов.</div></div>'; return; }
      html += '<table><thead><tr><th class="num">Цена товара</th><th class="num">Разница в цене в %</th><th>Магазин демпинг</th><th>Ссылка на магазин конкурента</th><th>Наличие</th><th>Статус</th><th></th></tr></thead><tbody>';
      pr.forEach(function (r) {
        var cur = S.run.current && S.run.current.linkId === r.linkId;
        var devCls = r.deviation == null ? '' : (r.deviation < 0 ? 'neg' : r.deviation > 0 ? 'pos' : '');
        html += '<tr class="' + (r.dumping ? 'dump' : '') + '"' + (r.enabled ? '' : ' style="opacity:.5"') + '>' +
          '<td class="num">' + (r.price != null ? PM.fmtMoney(r.price) : '—') + (r.stale ? '<span class="stale">последняя известная</span>' : '') + '</td>' +
          '<td class="num dev ' + devCls + '">' + PM.fmtPct(r.deviation) + '</td>' +
          '<td>' + esc(PM.dumpLabel(r)).replace(/— (Да)$/, '— <b style="color:var(--bad)">$1</b>') + '</td>' +
          '<td><a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 90)) + '</a></td>' +
          '<td>' + esc(r.availability || '—') + '</td>' +
          '<td class="st ' + (cur ? 'new' : r.status) + '">' + (cur ? 'проверяется…' : esc(r.statusText)) +
          (r.checkedAt ? '<small>' + PM.fmtTime(r.checkedAt) + '</small>' : '') +
          (r.error && r.status !== 'ok' ? '<small>' + esc(r.error) + '</small>' : '') +
          (r.articleFound === false && r.status === 'ok' ? '<span class="warn-art">⚠ артикул ' + esc(r.article) + ' не найден на странице — проверьте, тот ли это товар</span>' : '') +
          '</td>' +
          '<td><button class="btn sm" data-check="' + esc(r.linkId) + '" title="Проверить эту ссылку сейчас, вне очереди">⟳</button></td></tr>';
      });
      html += '</tbody></table></div>';
    });
    $('#results').innerHTML = html || '<div class="empty">Демпинга не найдено.</div>';
  }
  $('#results').addEventListener('click', function (e) {
    var b = e.target.closest('[data-check]');
    if (!b) return;
    var x = PM.findLink(S.positions, b.dataset.check);
    var go = function () {
      b.disabled = true; b.textContent = '…';
      send({ type: 'checkNow', linkId: b.dataset.check }).finally(function () { b.disabled = false; b.textContent = '⟳'; });
    };
    if (x) requestAccess([x.link.url]).then(go); else go();
  });
  $('#onlyDump').onchange = renderResults;
  $('#btnCsv').onclick = function () {
    var rows = PM.reportRows(S.positions, S.results, S.settings).filter(function (r) { return !r.excluded && r.enabled; });
    download('конкуренты_' + stamp() + '.csv', PM.toCSV(rows));
  };

  /* ---------------- редактор позиций ---------------- */
  function linksToText(links) {
    return links.map(function (l) {
      var parts = [l.url];
      if (l.anchor || l.selector) parts.push(l.anchor || '');
      if (l.selector) parts.push(l.selector);
      return (l.enabled ? '' : '# ') + parts.join(' | ');
    }).join('\n');
  }
  function textToLinks(text, old) {
    var pool = (old || []).slice();
    return String(text || '').split(/\r?\n/).map(function (line) {
      line = line.trim();
      if (!line) return null;
      var enabled = true;
      if (line[0] === '#') { enabled = false; line = line.replace(/^#\s*/, ''); }
      var parts = line.split(/\s*\|\s*/);
      var url = (parts[0] || '').trim();
      if (!/^https?:\/\//i.test(url)) return null;
      var anchor = (parts[1] || '').trim(), selector = parts.slice(2).join(' | ').trim();
      // сохраняем id ссылки, чтобы не терять историю цен при редактировании
      var i = pool.findIndex(function (l) { return l.url === url && l.anchor === anchor; });
      if (i < 0) i = pool.findIndex(function (l) { return l.url === url; });
      var id = i >= 0 ? pool.splice(i, 1)[0].id : PM.uid('l');
      return { id: id, url: url, anchor: anchor, selector: selector, enabled: enabled };
    }).filter(Boolean);
  }
  function renderEditor() {
    if (!draft) draft = JSON.parse(JSON.stringify(S.positions));
    $('#dirty').hidden = !dirty;
    if (!draft.length) { $('#posList').innerHTML = '<div class="empty">Список пуст. Нажмите «+ Позиция», «Импорт» или «Загрузить пример».</div>'; return; }
    $('#posList').innerHTML = draft.map(function (p, i) {
      return '<div class="edit" data-i="' + i + '">' +
        '<label>Наименование<input data-f="name" value="' + esc(p.name) + '"></label>' +
        '<label>Артикул<input data-f="article" value="' + esc(p.article) + '"></label>' +
        '<label>Наша цена, ₽<input data-f="ourPrice" type="number" min="0" step="1" value="' + esc(p.ourPrice || '') + '"></label>' +
        '<button class="btn sm" data-del="' + i + '" title="Удалить позицию">✕</button>' +
        '<label class="links">Ссылки конкурентов (' + p.links.length + ')<textarea data-f="links" spellcheck="false" rows="' + Math.max(3, p.links.length + 1) + '" placeholder="https://магазин.ru/товар/…">' + esc(linksToText(p.links)) + '</textarea></label>' +
        '</div>';
    }).join('');
  }
  function markDirty() { dirty = true; $('#dirty').hidden = false; }
  $('#posList').addEventListener('input', function (e) {
    var card = e.target.closest('.edit'); if (!card) return;
    var p = draft[+card.dataset.i], f = e.target.dataset.f;
    if (f === 'links') p.links = textToLinks(e.target.value, p.links);
    else if (f === 'ourPrice') p.ourPrice = Number(e.target.value) || 0;
    else if (f) p[f] = e.target.value;
    markDirty();
  });
  $('#posList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]'); if (!b) return;
    var p = draft[+b.dataset.del];
    if (!confirm('Удалить позицию «' + (p.name || p.article || 'без названия') + '»?')) return;
    draft.splice(+b.dataset.del, 1); markDirty(); renderEditor();
  });
  $('#btnAddPos').onclick = function () {
    draft.unshift({ id: PM.uid('p'), name: '', article: '', ourPrice: 0, links: [] });
    markDirty(); renderEditor();
    var first = $('#posList input'); if (first) first.focus();
  };
  $('#btnSample').onclick = function () {
    var res = PM.importPositions(PM.exportPositionsCSV(PM.normalizePositions(PM.SAMPLE_POSITIONS)), draft);
    draft = res.positions; markDirty(); renderEditor();
    toast('Добавлено позиций: ' + res.added + ', ссылок: ' + res.links + '. Не забудьте «Сохранить».');
  };
  $('#btnSavePos').onclick = function () {
    var clean = PM.normalizePositions(draft);
    var access = requestAccess(enabledUrls(clean)); // запрос — синхронно в обработчике клика
    chrome.storage.local.set({ positions: clean }).then(function () {
      draft = null; dirty = false;
      return access;
    }).then(function (ok) {
      toast(ok ? 'Сохранено' : 'Сохранено, но доступ к части сайтов не выдан');
    });
  };
  $('#btnExportPos').onclick = function () { download('позиции_' + stamp() + '.csv', PM.exportPositionsCSV(PM.normalizePositions(draft || S.positions))); };

  // импорт
  $('#btnImport').onclick = function () { $('#importText').value = ''; $('#importDlg').showModal(); };
  $('#importFile').onchange = function (e) {
    var f = e.target.files[0]; if (!f) return;
    f.arrayBuffer().then(function (buf) {
      var t = new TextDecoder('utf-8').decode(buf);
      if (t.indexOf('\ufffd') >= 0) t = new TextDecoder('windows-1251').decode(buf); // CSV из Excel в 1251
      $('#importText').value = t;
    });
  };
  $('#importDlg').addEventListener('close', function () {
    if ($('#importDlg').returnValue !== 'ok') return;
    var res = PM.importPositions($('#importText').value, $('#importReplace').checked ? [] : draft);
    draft = res.positions; markDirty(); renderEditor();
    toast('Импорт: новых позиций ' + res.added + ', ссылок ' + res.links + '. Проверьте и нажмите «Сохранить».');
  });

  /* ---------------- настройки ---------------- */
  function renderSettings() {
    var f = $('#settingsForm'), st = S.settings;
    Object.keys(st).forEach(function (k) {
      var el = f.elements[k];
      if (!el) return;
      if (k === 'openMode') { f.querySelectorAll('[name=openMode]').forEach(function (r) { r.checked = r.value === st.openMode; }); return; }
      if (el.type === 'checkbox') el.checked = !!st[k];
      else if (k === 'excludedDomains') el.value = st[k].join(', ');
      else el.value = st[k];
    });
    updateEstimate();
  }
  function readSettings() {
    var f = $('#settingsForm'), o = {};
    ['minDelayMin', 'maxDelayMin', 'domainGapMin', 'repeatHours', 'pageTimeoutSec', 'renderWaitMinSec', 'renderWaitMaxSec', 'blockBackoffHours', 'dumpThresholdPct'].forEach(function (k) { o[k] = Number(f.elements[k].value); });
    o.openMode = (f.querySelector('[name=openMode]:checked') || {}).value;
    o.notify = f.elements.notify.checked;
    o.excludedDomains = f.elements.excludedDomains.value;
    return PM.normalizeSettings(o);
  }
  function updateEstimate() {
    var st = readSettings();
    var n = PM.buildQueue(S.positions, st).length;
    var sites = {};
    PM.allLinks(S.positions).forEach(function (x) { if (x.link.enabled && !PM.isExcluded(x.link.url, st.excludedDomains)) sites[PM.siteOf(x.link.url)] = (sites[PM.siteOf(x.link.url)] || 0) + 1; });
    var maxPerSite = Object.keys(sites).reduce(function (m, k) { return Math.max(m, sites[k]); }, 0);
    var est = Math.max(PM.estimateCycleMs(n, st), Math.max(0, maxPerSite - 1) * st.domainGapMin * PM.MIN);
    $('#estimate').textContent = 'Ссылок к проверке: ' + n + ', сайтов: ' + Object.keys(sites).length + '. Один круг займёт примерно ' + PM.fmtDuration(est) +
      (st.repeatHours > 0 && est > st.repeatHours * PM.HOUR ? ' — дольше интервала повтора: новый круг начнётся сразу после окончания.' : '.');
  }
  $('#settingsForm').addEventListener('input', updateEstimate);
  $('#settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    chrome.storage.local.set({ settings: readSettings() }).then(function () {
      $('#setSaved').hidden = false; setTimeout(function () { $('#setSaved').hidden = true; }, 2000);
      send({ type: 'refreshBadge' });
    });
  });
  $('#btnResetPauses').onclick = function () { send({ type: 'resetSitePauses' }).then(function () { toast('Паузы по сайтам сброшены'); }); };

  /* ---------------- журнал ---------------- */
  function renderLog() {
    $('#log').innerHTML = S.log.slice().reverse().map(function (e) {
      return '<li class="' + esc(e.level) + '"><time>' + new Date(e.t).toLocaleString('ru-RU') + '</time><span>' + esc(e.msg) + '</span></li>';
    }).join('') || '<li><span class="hint">Пока пусто.</span></li>';
  }
  $('#btnClearLog').onclick = function () { chrome.storage.local.set({ log: [] }); };

  /* ---------------- загрузка и живые обновления ---------------- */
  function apply(data) {
    if ('settings' in data) S.settings = PM.normalizeSettings(data.settings);
    if ('positions' in data) S.positions = PM.normalizePositions(data.positions);
    if ('results' in data) S.results = data.results || {};
    if ('run' in data) S.run = Object.assign({ state: 'idle', queue: [] }, data.run || {});
    if ('log' in data) S.log = data.log || [];
  }
  chrome.storage.local.get(['settings', 'positions', 'results', 'run', 'log']).then(function (d) {
    apply(d);
    renderStatus(); renderResults(); renderEditor(); renderSettings(); renderLog(); checkPermissions(); showTab();
  });
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area !== 'local') return;
    var d = {};
    Object.keys(ch).forEach(function (k) { d[k] = ch[k].newValue; });
    apply(d);
    if ('run' in d || 'results' in d || 'positions' in d || 'settings' in d) { renderStatus(); renderResults(); }
    if ('positions' in d && !dirty) { draft = null; renderEditor(); }
    if ('positions' in d || 'settings' in d) { checkPermissions(); updateEstimate(); }
    if ('settings' in d && !$('#settingsForm').contains(document.activeElement)) renderSettings();
    if ('log' in d) renderLog();
  });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
