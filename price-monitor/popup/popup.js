/* Попап: статус круга, текущий демпинг, старт/пауза. */
'use strict';
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var D = {};

  function render() {
    var st = PM.normalizeSettings(D.settings), positions = PM.normalizePositions(D.positions);
    var run = Object.assign({ state: 'idle', queue: [] }, D.run || {});
    var s;
    if (run.state === 'running') s = 'Идёт круг: <b>' + (run.done || 0) + ' из ' + (run.total || 0) + '</b>' + (run.current ? ' · проверяю…' : run.nextAt ? ' · след. проверка <b>' + PM.fmtTime(run.nextAt) + '</b>' : '');
    else if (run.state === 'paused') s = 'Пауза · в очереди ' + run.queue.length;
    else if (run.state === 'waiting') s = 'Следующий круг <b>' + PM.fmtTime(run.nextAt) + '</b>';
    else s = positions.length ? 'Остановлено' : 'Добавьте позиции в панели';
    $('#state').innerHTML = s;
    $('#progress').hidden = run.state !== 'running' && run.state !== 'paused';
    $('#progress i').style.width = (run.total ? Math.round(100 * (run.done || 0) / run.total) : 0) + '%';
    $('#start').hidden = run.state === 'running' || run.state === 'paused';
    $('#pause').hidden = run.state !== 'running';
    $('#resume').hidden = run.state !== 'paused';

    var rows = PM.reportRows(positions, D.results || {}, st)
      .filter(function (r) { return r.status === 'ok' && r.dumping && !r.excluded && r.enabled; })
      .sort(function (a, b) { return a.deviation - b.deviation; });
    $('#dump').innerHTML = rows.length ? rows.slice(0, 30).map(function (r) {
      return '<li><span>' + esc(r.store) + ' · ' + PM.fmtMoney(r.price) + '</span><span class="d">' + PM.fmtPct(r.deviation) + '</span><span class="n">' + esc(r.name || r.article) + '</span></li>';
    }).join('') : '<li><span class="none">Демпинга не найдено' + (Object.keys(D.results || {}).length ? '' : ' (ещё не проверяли)') + '.</span></li>';
  }
  function load() { chrome.storage.local.get(['settings', 'positions', 'results', 'run']).then(function (d) { D = d; render(); }); }
  chrome.storage.onChanged.addListener(load);
  load();

  var urls = function () {
    var st = PM.normalizeSettings(D.settings);
    return PM.allLinks(PM.normalizePositions(D.positions)).filter(function (x) { return x.link.enabled && !PM.isExcluded(x.link.url, st.excludedDomains); }).map(function (x) { return x.link.url; });
  };
  $('#start').onclick = function () {
    // окно запроса разрешений закрывает попап — поэтому, если доступа нет, просим его в панели
    var origins = PM.originPatterns(urls());
    (origins.length ? chrome.permissions.contains({ origins: origins }) : Promise.resolve(true)).then(function (ok) {
      if (ok) return chrome.runtime.sendMessage({ type: 'start' });
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html#results') });
      window.close();
    });
  };
  $('#pause').onclick = function () { chrome.runtime.sendMessage({ type: 'pause' }); };
  $('#resume').onclick = function () { chrome.runtime.sendMessage({ type: 'resume' }); };
  $('#open').onclick = function () { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') }); window.close(); };
})();
