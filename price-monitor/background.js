/*
 * «Монитор цен конкурентов» — service worker (Manifest V3).
 *
 * Как работает круг проверки:
 *   • очередь = все ссылки конкурентов, перемешанные и разнесённые по сайтам;
 *   • за раз проверяется ОДНА ссылка: страница открывается в свёрнутом окне (или фоновой вкладке),
 *     ждём загрузку и отрисовку, читаем цену из DOM, закрываем;
 *   • следующая проверка — через случайную паузу (по умолчанию 5–10 мин), один сайт — не чаще domainGapMin;
 *   • если сайт показал капчу/«слишком много запросов» — НЕ обходим: ставим сайт на паузу (6 ч, при повторе ×2)
 *     и переносим его оставшиеся ссылки на следующий круг;
 *   • после круга — новый через repeatHours.
 * Состояние хранится в chrome.storage.local, таймеры — chrome.alarms (переживают «засыпание» воркера).
 */
'use strict';
importScripts('lib/core.js');

var TICK = 'pm-tick', CYCLE = 'pm-cycle', WATCHDOG = 'pm-watchdog';
var busy = false;

/* ---------------- storage ---------------- */
function get(keys) { return chrome.storage.local.get(keys); }
function set(obj) { return chrome.storage.local.set(obj); }
async function load() {
  var s = await get(['settings', 'positions', 'results', 'run']);
  return {
    settings: PM.normalizeSettings(s.settings),
    positions: PM.normalizePositions(s.positions),
    results: s.results || {},
    run: Object.assign({ state: 'idle', queue: [], total: 0, done: 0, domainLast: {}, domainBlockedUntil: {}, domainBackoff: {} }, s.run || {})
  };
}
async function log(level, msg) {
  var s = await get(['log']);
  var arr = s.log || [];
  arr.push({ t: Date.now(), level: level, msg: msg });
  if (arr.length > 400) arr = arr.slice(-400);
  await set({ log: arr });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function rand(a, b) { return a + Math.random() * (b - a); }

/* ---------------- открытие страницы и чтение цены ---------------- */
async function openPage(url, mode) {
  if (mode === 'window') {
    try {
      var w = await chrome.windows.create({ url: url, focused: false, state: 'minimized', type: 'normal' });
      return { tabId: w.tabs[0].id, windowId: w.id };
    } catch (e) { /* некоторые оконные менеджеры не дают свёрнутое окно — откроем вкладку */ }
  }
  var t = await chrome.tabs.create({ url: url, active: false });
  return { tabId: t.id, windowId: null };
}
async function closePage(h) {
  try {
    if (h.windowId != null) await chrome.windows.remove(h.windowId);
    else await chrome.tabs.remove(h.tabId);
  } catch (e) { /* уже закрыто пользователем */ }
}
function waitComplete(tabId, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var finished = false, poll;
    var end = function (fn, v) {
      if (finished) return; finished = true;
      clearTimeout(timer); clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(onUpd);
      fn(v);
    };
    var onUpd = function (id, info) { if (id === tabId && info.status === 'complete') end(resolve, 'complete'); };
    var timer = setTimeout(function () { end(resolve, 'timeout'); }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
    // опрос заодно не даёт воркеру уснуть на медленной странице
    poll = setInterval(function () {
      chrome.tabs.get(tabId).then(function (t) { if (t.status === 'complete') end(resolve, 'complete'); })
        .catch(function () { end(reject, new Error('Вкладка закрыта до окончания проверки')); });
    }, 2000);
  });
}
async function readPrice(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['lib/extract.js'] });
  var out = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function (o) { return self.__pmExtract(document, o); },
    args: [opts]
  });
  return out && out[0] && out[0].result;
}

/** Проверка одной ссылки. Возвращает запись результата (и сохраняет её). */
async function checkLink(linkId, reason) {
  var d = await load();
  var x = PM.findLink(d.positions, linkId);
  if (!x) return null;
  var st = d.settings, pos = x.pos, link = x.link;
  var store = PM.hostOf(link.url);
  var prev = d.results[linkId] || {};
  var rec = {
    checkedAt: Date.now(), status: 'error', price: null, finalUrl: link.url,
    lastOkPrice: prev.lastOkPrice || null, lastOkAt: prev.lastOkAt || 0, history: prev.history || []
  };

  var pattern = PM.originPatterns([link.url]);
  var allowed = await chrome.permissions.contains({ origins: pattern }).catch(function () { return false; });
  if (!allowed) {
    rec.status = 'noaccess';
    rec.error = 'Нет разрешения на сайт ' + store + ' — откройте панель и нажмите «Выдать доступ к сайтам».';
    return save(rec);
  }

  var keepAlive = setInterval(function () { chrome.runtime.getPlatformInfo(); }, 20000);
  var h = null;
  try {
    h = await openPage(link.url, st.openMode);
    chrome.tabs.update(h.tabId, { muted: true }).catch(function () { });
    var how = await waitComplete(h.tabId, st.pageTimeoutSec * 1000);
    await sleep(rand(st.renderWaitMinSec, st.renderWaitMaxSec) * 1000);
    var r = null;
    for (var attempt = 0; attempt < 4; attempt++) {
      r = await readPrice(h.tabId, { article: pos.article, anchor: link.anchor, selector: link.selector });
      if (!r || r.price != null || r.blocked || r.notFound) break;
      await sleep(3000); // цена может дорисовываться скриптом
    }
    if (!r) throw new Error('Страница не ответила');
    rec.finalUrl = r.url || link.url;
    rec.title = r.title || '';
    rec.method = r.method;
    rec.availability = r.availability || '';
    rec.articleFound = r.articleFound;
    if (link.anchor) rec.anchorFound = r.anchorFound !== false;
    if (r.price != null) {
      rec.status = 'ok'; rec.price = r.price; rec.lastOkPrice = r.price; rec.lastOkAt = rec.checkedAt;
      rec.history = rec.history.concat([{ t: rec.checkedAt, p: r.price }]).slice(-60);
    } else if (r.blocked) {
      rec.status = 'blocked'; rec.error = 'Сайт показал защиту от ботов («' + r.blocked + '»). Обходить не будем — сайт поставлен на паузу.';
    } else if (r.notFound) {
      rec.status = 'notfound'; rec.error = 'Похоже, страница товара удалена (404 / «не найдено»).';
    } else {
      rec.status = 'noprice';
      rec.error = link.anchor && r.anchorFound === false ? 'На странице нет текста «' + link.anchor + '».'
        : 'Цена не найдена' + (how === 'timeout' ? ' (страница грузилась дольше ' + st.pageTimeoutSec + ' с)' : '') + '. Можно задать CSS-селектор цены для этой ссылки.';
    }
  } catch (e) {
    var m = String(e && e.message || e);
    if (/Cannot access|permission|must request permission/i.test(m)) { rec.status = 'noaccess'; rec.error = 'Нет доступа к странице: ' + m; }
    else { rec.status = 'error'; rec.error = m; }
  } finally {
    clearInterval(keepAlive);
    if (h) await closePage(h);
  }
  return save(rec);

  async function save(rec) {
    var cur = await get(['results']);
    var results = cur.results || {};
    results[linkId] = rec;
    await set({ results: results });
    var tag = (reason === 'manual' ? '[вручную] ' : '') + store + ' · ' + (pos.article || pos.name) + ': ';
    if (rec.status === 'ok') {
      var dev = PM.deviation(rec.price, pos.ourPrice);
      await log(dev != null && PM.isDumping(rec.price, pos.ourPrice, st.dumpThresholdPct) ? 'warn' : 'info',
        tag + PM.fmtMoney(rec.price) + ' (' + PM.fmtPct(dev) + ')' + (rec.articleFound === false ? ' · артикул на странице не найден — проверьте ссылку' : ''));
      maybeNotify(pos, link, rec, prev, st);
    } else {
      await log(rec.status === 'blocked' ? 'error' : 'warn', tag + (PM.STATUS[rec.status] || rec.status) + (rec.error ? ' — ' + rec.error : ''));
    }
    await updateBadge();
    return rec;
  }
}

function maybeNotify(pos, link, rec, prev, st) {
  if (!st.notify || !pos.ourPrice) return;
  if (!PM.isDumping(rec.price, pos.ourPrice, st.dumpThresholdPct)) return;
  var wasPrice = prev && prev.status === 'ok' ? prev.price : null;
  var was = wasPrice != null && PM.isDumping(wasPrice, pos.ourPrice, st.dumpThresholdPct);
  if (was && rec.price >= wasPrice) return; // уже сообщали, цена не упала ещё ниже
  chrome.notifications.create('pm-' + link.id + '-' + rec.checkedAt, {
    type: 'basic', iconUrl: 'icons/icon-128.png', priority: 1,
    title: 'Демпинг: ' + PM.hostOf(link.url) + ' ' + PM.fmtPct(PM.deviation(rec.price, pos.ourPrice)),
    message: (pos.name || pos.article) + '\n' + PM.fmtMoney(rec.price) + ' при нашей ' + PM.fmtMoney(pos.ourPrice)
  });
}

async function updateBadge() {
  var d = await load();
  var rows = PM.reportRows(d.positions, d.results, d.settings).filter(function (r) { return r.status === 'ok' && r.dumping && !r.excluded; });
  var n = rows.length;
  await chrome.action.setBadgeBackgroundColor({ color: n ? '#d93025' : '#188038' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  var title = 'Монитор цен конкурентов';
  if (d.run.state === 'running') title += '\nИдёт круг: ' + d.run.done + ' из ' + d.run.total + (d.run.nextAt ? ', следующая проверка ' + PM.fmtTime(d.run.nextAt) : '');
  else if (d.run.state === 'waiting') title += '\nСледующий круг ' + PM.fmtTime(d.run.nextAt);
  else if (d.run.state === 'paused') title += '\nНа паузе';
  if (n) title += '\nДемпинг: ' + n;
  await chrome.action.setTitle({ title: title });
}

/* ---------------- круг проверки ---------------- */
async function schedule(name, when) {
  await chrome.alarms.clear(name);
  await chrome.alarms.create(name, { when: Math.max(when, Date.now() + 1000) });
}
async function startCycle(manual) {
  var d = await load();
  var queue = PM.buildQueue(d.positions, d.settings);
  var run = d.run;
  await chrome.alarms.clear(CYCLE);
  if (!queue.length) {
    run.state = 'idle'; run.queue = []; run.nextAt = null;
    await set({ run: run });
    await log('warn', 'Нечего проверять: добавьте позиции и ссылки конкурентов.');
    return updateBadge();
  }
  Object.assign(run, { state: 'running', queue: queue, total: queue.length, done: 0, cycleStartedAt: Date.now(), current: null, nextAt: Date.now() });
  await set({ run: run });
  await log('info', (manual ? 'Запуск вручную. ' : 'Новый круг. ') + 'В очереди ' + queue.length + ' ссылок, ориентировочно ' + PM.fmtDuration(PM.estimateCycleMs(queue.length, d.settings)) + '.');
  await updateBadge();
  tick(); // первая проверка — сразу, но не держим ответ на «Старт», пока она идёт
}
async function finishCycle(d) {
  var run = d.run, st = d.settings;
  run.current = null; run.queue = [];
  run.lastCycleFinishedAt = Date.now();
  var rows = PM.reportRows(d.positions, d.results, st).filter(function (r) { return !r.excluded && r.enabled; });
  var dump = rows.filter(function (r) { return r.status === 'ok' && r.dumping; }).length;
  var bad = rows.filter(function (r) { return r.checkedAt >= (run.cycleStartedAt || 0) && r.status !== 'ok'; }).length;
  if (st.repeatHours > 0) {
    run.state = 'waiting';
    run.nextAt = Math.max((run.cycleStartedAt || Date.now()) + st.repeatHours * PM.HOUR, Date.now() + st.minDelayMin * PM.MIN);
    await schedule(CYCLE, run.nextAt);
  } else { run.state = 'idle'; run.nextAt = null; }
  await set({ run: run });
  await log('info', 'Круг завершён: ' + rows.length + ' ссылок, демпинг — ' + dump + ', без цены — ' + bad + '.' + (run.nextAt ? ' Следующий круг ' + PM.fmtTime(run.nextAt) + '.' : ''));
  if (st.notify) chrome.notifications.create('pm-cycle-' + Date.now(), {
    type: 'basic', iconUrl: 'icons/icon-128.png', title: 'Проверка цен завершена',
    message: 'Демпинг: ' + dump + ' из ' + rows.length + (bad ? '\nНе удалось получить цену: ' + bad : '')
  });
  await updateBadge();
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    var d = await load();
    var run = d.run, now = Date.now();
    if (run.state !== 'running') return;
    if (run.current && now - (run.current.startedAt || 0) < 5 * PM.MIN) return; // проверка ещё идёт
    if (run.current) { await log('warn', 'Предыдущая проверка прервалась (браузер закрывали?) — идём дальше.'); run.current = null; }

    var pick;
    for (;;) {
      pick = PM.pickNext(run.queue, d.positions, run, d.settings, now);
      if (pick.missing) { run.queue.splice(pick.index, 1); run.total = Math.max(0, run.total - 1); continue; }
      break;
    }
    if (pick.done) { await set({ run: run }); return finishCycle(d); }
    if (pick.waitUntil) {
      run.nextAt = Math.max(pick.waitUntil, now + 30 * 1000);
      await set({ run: run });
      await schedule(TICK, run.nextAt);
      return updateBadge();
    }

    var linkId = run.queue.splice(pick.index, 1)[0];
    var x = PM.findLink(d.positions, linkId);
    var site = PM.siteOf(x.link.url);
    run.current = { linkId: linkId, startedAt: now };
    run.nextAt = null;
    await set({ run: run });
    await updateBadge();

    var rec = await checkLink(linkId, 'auto');

    d = await load(); run = d.run; // пока шла проверка, могли нажать «Пауза»/«Стоп»
    run.current = null;
    run.domainLast[site] = Date.now();
    run.lastCheckAt = Date.now();
    if (run.state !== 'idle') run.done = (run.done || 0) + 1;
    if (rec && rec.status === 'blocked') {
      var lvl = (run.domainBackoff[site] || 0) + 1;
      run.domainBackoff[site] = lvl;
      var pause = Math.min(7 * 24 * PM.HOUR, d.settings.blockBackoffHours * PM.HOUR * Math.pow(2, lvl - 1));
      run.domainBlockedUntil[site] = Date.now() + pause;
      var before = run.queue.length;
      run.queue = run.queue.filter(function (id) { var y = PM.findLink(d.positions, id); return !y || PM.siteOf(y.link.url) !== site; });
      var moved = before - run.queue.length;
      run.total -= moved;
      await log('error', 'Сайт ' + site + ' ограничил доступ → пауза по сайту ' + PM.fmtDuration(pause) + (moved ? ', ещё ' + moved + ' его ссылок перенесено на следующий круг' : '') + '.');
    } else if (rec && rec.status === 'ok') {
      delete run.domainBackoff[site];
    }
    if (run.state !== 'running') { await set({ run: run }); return updateBadge(); }
    if (!run.queue.length) { await set({ run: run }); return finishCycle(d); }
    run.nextAt = Date.now() + PM.randomDelayMs(d.settings);
    await set({ run: run });
    await schedule(TICK, run.nextAt);
    await updateBadge();
  } catch (e) {
    await log('error', 'Сбой планировщика: ' + (e && e.message || e));
    var d2 = await load();
    if (d2.run.state === 'running') {
      d2.run.current = null;
      d2.run.nextAt = Date.now() + PM.randomDelayMs(d2.settings);
      await set({ run: d2.run });
      await schedule(TICK, d2.run.nextAt);
    }
  } finally { busy = false; }
}

/** После перезапуска браузера/обновления расширения таймеры могли пропасть — восстанавливаем. */
async function ensureAlarms() {
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 10 });
  var d = await load();
  var run = d.run;
  if (run.state === 'running') {
    var a = await chrome.alarms.get(TICK);
    if (!a && !busy) {
      if (run.current && Date.now() - run.current.startedAt > 5 * PM.MIN) { run.current = null; await set({ run: run }); }
      await schedule(TICK, Math.max(run.nextAt || 0, Date.now() + 30 * 1000));
    }
  } else if (run.state === 'waiting') {
    var c = await chrome.alarms.get(CYCLE);
    if (!c) await schedule(CYCLE, run.nextAt || Date.now() + 60 * 1000);
  }
  await updateBadge();
}

/* ---------------- события ---------------- */
chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === TICK) tick();
  else if (a.name === CYCLE) startCycle(false);
  else if (a.name === WATCHDOG) ensureAlarms();
});
chrome.runtime.onStartup.addListener(ensureAlarms);
chrome.runtime.onInstalled.addListener(async function (details) {
  var s = await get(['positions', 'settings']);
  if (!s.settings) await set({ settings: PM.normalizeSettings({}) });
  if (details.reason === 'install') {
    if (!s.positions) await set({ positions: PM.normalizePositions(PM.SAMPLE_POSITIONS) });
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html#positions') });
  }
  ensureAlarms();
});
chrome.notifications.onClicked.addListener(function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  (async function () {
    var d = await load(), run = d.run;
    switch (msg.type) {
      case 'start':
        if (run.state === 'running') return { ok: false, error: 'Круг уже идёт' };
        await startCycle(true); return { ok: true };
      case 'pause':
        if (run.state !== 'running') return { ok: false, error: 'Сейчас ничего не выполняется' };
        run.state = 'paused'; run.nextAt = null;
        await chrome.alarms.clear(TICK); await set({ run: run });
        await log('info', 'Пауза. Осталось в очереди: ' + run.queue.length + '.');
        await updateBadge(); return { ok: true };
      case 'resume':
        if (run.state !== 'paused') return { ok: false, error: 'Не на паузе' };
        // после паузы тоже выдерживаем интервал от последней проверки — частые «пауза/продолжить» не ускоряют обход
        run.state = 'running';
        run.nextAt = Math.max(Date.now() + 30 * 1000, (run.lastCheckAt || 0) + PM.randomDelayMs(d.settings));
        await set({ run: run });
        await schedule(TICK, run.nextAt);
        await log('info', 'Продолжаем круг, следующая проверка ' + PM.fmtTime(run.nextAt) + '.');
        await updateBadge(); return { ok: true };
      case 'stop':
        run.state = 'idle'; run.queue = []; run.nextAt = null; run.current = null;
        await chrome.alarms.clear(TICK); await chrome.alarms.clear(CYCLE);
        await set({ run: run }); await log('info', 'Остановлено. Автоповтор выключен до следующего «Старт».');
        await updateBadge(); return { ok: true };
      case 'checkNow':
        if (busy || run.current) return { ok: false, error: 'Сейчас уже идёт проверка — подождите минуту.' };
        busy = true;
        try {
          var rec = await checkLink(msg.linkId, 'manual');
          var x = PM.findLink(d.positions, msg.linkId);
          if (x) { var dd = await load(); dd.run.domainLast[PM.siteOf(x.link.url)] = Date.now(); dd.run.lastCheckAt = Date.now(); await set({ run: dd.run }); }
          return { ok: true, rec: rec };
        } finally { busy = false; }
      case 'resetSitePauses':
        run.domainBlockedUntil = {}; run.domainBackoff = {}; await set({ run: run });
        await log('info', 'Паузы по сайтам сброшены.'); return { ok: true };
      case 'refreshBadge':
        await updateBadge(); return { ok: true };
      default:
        return { ok: false, error: 'unknown' };
    }
  })().then(sendResponse, function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
  return true;
});

ensureAlarms();
