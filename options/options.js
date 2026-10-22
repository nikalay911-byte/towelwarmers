/* Страница настроек расширения. Пишет те же ключи, что и модалка настроек на странице прайса. */
'use strict';
(function () {
  var ST = window.OST.store;
  var FIELDS = ['lowStock', 'density', 'view', 'theme', 'autoMin', 'colorLimit', 'reuseConfig'];

  function val(id) {
    var el = document.getElementById(id);
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.dataset.num === '1') return +el.value || 0;
    return el.value;
  }
  function setVal(id, v) {
    var el = document.getElementById(id);
    if (!el || v === undefined || v === null) return;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }

  ST.loadSettings().then(function (s) {
    s = s || {};
    FIELDS.forEach(function (k) { setVal(k, s[k]); });
    document.documentElement.setAttribute('data-theme', s.theme || 'auto');
    document.documentElement.setAttribute('data-density', s.density || 'compact');
  });

  document.getElementById('save').addEventListener('click', function () {
    var o = {};
    FIELDS.forEach(function (k) { o[k] = val(k); });
    ST.saveSettings(o).then(function () {
      try {
        if (window.chrome && chrome.storage) chrome.storage.local.set({ settings: o }, showSaved);
        else showSaved();
      } catch (e) { showSaved(); }
    });
  });

  function showSaved() {
    var n = document.getElementById('saved');
    n.classList.add('on');
    setTimeout(function () { n.classList.remove('on'); }, 1600);
  }

  document.getElementById('open').addEventListener('click', function () {
    if (window.chrome && chrome.tabs) chrome.tabs.create({ url: chrome.runtime.getURL('app/index.html') });
    else window.open('../app/index.html', '_blank');
  });

  document.getElementById('wipe').addEventListener('click', function () {
    if (!confirm('Удалить все сохранённые прайс-листы и настройки? Файлы на диске не пострадают.')) return;
    ST.clearAll().then(function () { alert('Готово. Загруженные прайсы удалены из браузера.'); });
  });
})();
