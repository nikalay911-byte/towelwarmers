/*
 * «Остатки Ника 41» — File System Access: запомнить файл и перечитывать его.
 * Нужен, чтобы «Обновить» и авто-обновление работали без повторного выбора файла.
 */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.OST = root.OST || {};
  root.OST.fs = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var ST = (root.OST && root.OST.store) ? root.OST.store : require('./store.js');

  function supported() { return typeof root.showOpenFilePicker === 'function'; }

  /** Выбрать файл: через showOpenFilePicker (есть handle) или input[type=file]. */
  function pick(accept) {
    var types = accept || [
      { description: 'Таблицы Excel / CSV', accept: { 'application/vnd.ms-excel': ['.xls'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'], 'text/csv': ['.csv'] } }
    ];
    if (!supported()) return Promise.resolve(null);
    return root.showOpenFilePicker({ multiple: false, types: types, excludeSuggestions: false })
      .then(function (handles) { return handles && handles[0] ? handles[0] : null; })
      .catch(function (e) { if (e && e.name === 'AbortError') return null; throw e; });
  }

  function handleKey(id) { return 'handle:' + (id || 'current'); }

  function saveHandle(id, handle) {
    if (!handle) return Promise.resolve(false);
    return ST.put('kv', handleKey(id), handle).then(function () { return true; }, function () { return false; });
  }
  function loadHandle(id) { return ST.get('kv', handleKey(id)).catch(function () { return null; }); }
  function dropHandle(id) { return ST.put('kv', handleKey(id), undefined); }

  function queryPermission(handle, mode) {
    if (!handle || !handle.queryPermission) return Promise.resolve('granted');
    return handle.queryPermission({ mode: mode || 'read' });
  }
  function requestPermission(handle, mode) {
    if (!handle || !handle.requestPermission) return Promise.resolve('granted');
    return handle.requestPermission({ mode: mode || 'read' });
  }

  /** handle -> File (с проверкой разрешения; при 'prompt' нужен жест пользователя). */
  function readFile(handle) {
    if (!handle || !handle.getFile) return Promise.reject(new Error('нет доступа к файлу'));
    return queryPermission(handle).then(function (p) {
      if (p === 'prompt') return requestPermission(handle);
      return p;
    }).then(function (p) {
      if (p !== 'granted') throw new Error('Разрешение на чтение файла не выдано');
      return handle.getFile();
    }).then(function (file) {
      return file.arrayBuffer().then(function (buf) {
        return { file: file, name: file.name, size: file.size, mtime: +file.lastModified, buffer: buf };
      });
    });
  }

  return {
    supported: supported, pick: pick, saveHandle: saveHandle, loadHandle: loadHandle,
    dropHandle: dropHandle, queryPermission: queryPermission, requestPermission: requestPermission,
    readFile: readFile
  };
});
