/*
 * «Остатки Ника 41» — хранилище. IndexedDB, чанками, с деградацией на file://.
 */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.OST = root.OST || {};
  root.OST.store = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DB_NAME = 'ostatki-nika-41';
  var DB_VERSION = 1;
  var CHUNK = 2000;
  var MAX_RAW = 40 * 1024 * 1024;
  var mem = Object.create(null); // fallback: file://, приватный режим
  var db = null, opening = null, broken = false;

  function hasIDB() {
    try { return !!(root.indexedDB && typeof indexedDB.open === 'function'); } catch (e) { return false; }
  }

  function open() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    if (!hasIDB() || broken) { broken = true; return Promise.resolve(null); }
    opening = new Promise(function (resolve) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { broken = true; opening = null; resolve(null); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        ['meta', 'rows', 'files', 'kv'].forEach(function (s) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        });
      };
      req.onsuccess = function () {
        db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { } db = null; };
        opening = null;
        resolve(db);
      };
      req.onerror = function () { broken = true; opening = null; resolve(null); };
      req.onblocked = function () { broken = true; opening = null; resolve(null); };
      setTimeout(function () { if (opening) { opening = null; resolve(db); } }, 4000);
    });
    return opening;
  }

  function tx(store, mode, fn) {
    return open().then(function (d) {
      if (!d) return null;
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode), out;
        try { out = fn(t.objectStore(store)); }
        catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.__req ? out.__req.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('abort')); };
      });
    });
  }

  function reqOf(r) { var o = { __req: r }; return o; }

  function offline() { return !hasIDB() || broken; }

  function put(store, key, value) {
    if (offline()) { if (value === undefined) delete mem[store + '|' + key]; else mem[store + '|' + key] = value; return Promise.resolve(); }
    return tx(store, 'readwrite', function (os) { os.put(value, key); return undefined; })
      .catch(function () { mem[store + '|' + key] = value; });
  }
  function get(store, key) {
    if (offline()) return Promise.resolve(mem[store + '|' + key]);
    return tx(store, 'readonly', function (os) { return reqOf(os.get(key)); })
      .then(function (v) { return v === null || v === undefined ? mem[store + '|' + key] : v; })
      .catch(function () { return mem[store + '|' + key]; });
  }
  function del(store, key) {
    if (offline()) { delete mem[store + '|' + key]; return Promise.resolve(); }
    return tx(store, 'readwrite', function (os) { os.delete(key); return undefined; })
      .catch(function () { delete mem[store + '|' + key]; });
  }
  function allKeys(store) {
    if (offline()) {
      var pre = store + '|', out = [];
      for (var k in mem) if (k.indexOf(pre) === 0) out.push(k.slice(pre.length));
      return Promise.resolve(out);
    }
    return tx(store, 'readonly', function (os) { return reqOf(os.getAllKeys()); }).catch(function () { return []; });
  }

  /** Сохранить датасет (мету отдельно, строки чанками, исходник — для пересборки). */
  function saveDataset(ds, rawBuffer) {
    var meta = {};
    for (var k in ds) if (k !== 'rows') meta[k] = ds[k];
    meta.rowCount = ds.rows.length;
    var tasks = [put('meta', ds.id, meta)];
    var rows = ds.rows, chunks = Math.ceil(rows.length / CHUNK);
    var p = Promise.resolve();
    for (var c = 0; c < chunks; c++) {
      (function (c) {
        p = p.then(function () { return put('rows', ds.id + '#' + c, rows.slice(c * CHUNK, (c + 1) * CHUNK)); });
      })(c);
    }
    tasks.push(p.then(function () { return put('meta', ds.id + '#chunks', chunks); }));
    if (rawBuffer && rawBuffer.byteLength <= MAX_RAW) {
      try {
        tasks.push(put('files', ds.id, rawBuffer.slice ? rawBuffer.slice(0) : rawBuffer));
      } catch (e) { /* ignore */ }
    } else {
      tasks.push(del('files', ds.id));
    }
    return Promise.all(tasks).then(function () { return ds.id; });
  }

  function loadDataset(id) {
    return get('meta', id).then(function (meta) {
      if (!meta) return null;
      return get('meta', id + '#chunks').then(function (chunks) {
        var rows = [];
        var p = Promise.resolve();
        for (var c = 0; c < (chunks || 0); c++) {
          (function (c) {
            p = p.then(function () { return get('rows', id + '#' + c).then(function (part) { if (part) rows = rows.concat(part); }); });
          })(c);
        }
        return p.then(function () {
          meta.rows = rows;
          return meta;
        });
      });
    });
  }

  function listDatasets() {
    return allKeys('meta').then(function (keys) {
      var ids = (keys || []).filter(function (k) { return typeof k === 'string' && k.indexOf('#') < 0; });
      var out = [];
      var p = Promise.resolve();
      ids.forEach(function (id) {
        p = p.then(function () { return get('meta', id).then(function (m) { if (m) out.push(m); }); });
      });
      return p.then(function () {
        out.sort(function (a, b) { return (b.importedAt || 0) - (a.importedAt || 0); });
        return out;
      });
    });
  }

  function deleteDataset(id) {
    return get('meta', id + '#chunks').then(function (chunks) {
      var p = Promise.resolve();
      for (var c = 0; c < (chunks || 0); c++) p = p.then(function () { return del('rows', id + '#' + c); });
      return p.then(function () {
        return Promise.all([del('meta', id), del('meta', id + '#chunks'), del('files', id)]);
      });
    });
  }

  function getRaw(id) { return get('files', id); }

  function saveSettings(s) { return put('kv', 'settings', s); }
  function loadSettings() { return get('kv', 'settings').then(function (v) { return v || null; }); }
  function saveState(s) { return put('kv', 'state', s); }
  function loadState() { return get('kv', 'state').then(function (v) { return v || null; }); }
  function clearAll() {
    return ['meta', 'rows', 'files', 'kv'].reduce(function (p, s) {
      return p.then(function () { return tx(s, 'readwrite', function (os) { os.clear(); }); });
    }, Promise.resolve()).catch(function () { mem = Object.create(null); });
  }

  function persistNote() { return !broken && hasIDB(); }

  return {
    available: hasIDB, persistent: persistNote, saveDataset: saveDataset, loadDataset: loadDataset,
    listDatasets: listDatasets, deleteDataset: deleteDataset, getRaw: getRaw,
    saveSettings: saveSettings, loadSettings: loadSettings, saveState: saveState, loadState: loadState,
    clearAll: clearAll, put: put, get: get, CHUNK: CHUNK
  };
});
