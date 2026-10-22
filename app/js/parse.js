/*
 * «Остатки Ника 41» — чтение Excel/CSV, поиск шапки таблицы, определение колонок.
 * Браузер + Node (CommonJS) без изменений.
 */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.OST = root.OST || {};
  root.OST.parse = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var U = (root.OST && root.OST.norm) ? root.OST : require('./util.js');

  /** Ключевые слова заголовков колонок. Первый элемент списка — «идеальное» совпадение. */
  var FIELD_KEYWORDS = {
    name: ['номенклатура', 'номенклатура', 'наименование', 'наименование товара', 'товар', 'позиция', 'название', 'product', 'item', 'артикул название'],
    char: ['характеристика', 'цвет', 'размер', 'модификация', 'вариант', 'комплектация', 'оттенок', 'исполнение', 'тип', 'покрытие', 'design', 'color', 'size'],
    qty: ['остаток', 'остатки', 'количество', 'кол-во', 'квас', 'наличие', 'свободный остаток', 'доступно', 'stock', 'qty', 'quantity', 'available', 'итого остаток'],
    sku: ['артикул', 'код', 'sku', 'index', 'штрихкод', 'ean', 'номер позиции', 'партномер', 'part'],
    price: ['цена', 'стоимость', 'прайс', 'price', 'розница', 'опт', 'мелкий опт', 'цена руб', 'руб/шт', 'итого', 'сумма'],
    warehouse: ['склад', 'магазин', 'магазин', 'филиал', 'офис', 'город', 'адрес', 'территория', 'клад', 'склад основной', 'розничный склад'],
    unit: ['ед', 'ед.', 'единица', 'единиц', 'шт', 'упак'],
    min: ['мин', 'резерв', 'брон', 'заказ', 'transit', 'в пути']
  };

  var STOP_HINTS = ['итого', 'всего', 'прайс-лист', 'прайс лист', 'уц', 'ндс', 'подготовлено', 'дата', 'страница', 'лист'];
  /** «ИТОГО 152» и повтор шапки на каждой странице — не строки прайса. */
  var TOTAL_RE = /^(итого|всего|среднего|баланс|скидка|ндс в том числе|всего позиц|всего наименований|всего строк|стр\.\s*\d|лист \d)/i;

  function isBlank(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }

  function cellText(v) {
    if (isBlank(v)) return '';
    if (v instanceof Date) return v.toLocaleDateString('ru-RU');
    return String(v).trim();
  }

  /**
   * Найти строку с заголовками.
   * @returns {{index:number, headers:string[], score:number}} index = -1, если шапки нет
   */
  function detectHeader(aoa, maxScan) {
    var limit = Math.min(aoa.length, maxScan || 25);
    var best = { index: -1, headers: [], score: 0 };
    for (var r = 0; r < limit; r++) {
      var row = aoa[r] || [];
      var filled = 0, texty = 0, keyBonus = 0, longest = 0;
      for (var c = 0; c < row.length; c++) {
        var t = cellText(row[c]);
        if (!t) continue;
        filled++;
        if (typeof row[c] === 'string' || isNaN(Number(t.replace(',', '.')))) texty++;
        longest = Math.max(longest, t.length);
        var n = U.norm(t);
        for (var f in FIELD_KEYWORDS) {
          var keys = FIELD_KEYWORDS[f];
          for (var k = 0; k < keys.length; k++) {
            if (n === keys[k]) { keyBonus += 6; break; }
            if (n.indexOf(keys[k]) >= 0) { keyBonus += 2.5; break; }
          }
        }
      }
      if (filled < 2) continue;
      var joined = U.norm(row.map(cellText).join(' '));
      var stopPenalty = 0;
      for (var s = 0; s < STOP_HINTS.length; s++) if (joined.indexOf(STOP_HINTS[s]) >= 0) stopPenalty += 1.5;
      var score = keyBonus * 3 + texty * 2 + Math.min(filled, 12) * 1.5 + (longest < 60 ? 1 : -2) - stopPenalty;
      if (score > best.score) best = { index: r, headers: row.map(cellText), score: score };
    }
    if (best.score < 8) return { index: -1, headers: [], score: best.score };
    return mergeSplitHeaders(aoa, best);
  }

  /**
   * Двухстрочные шапки («Остатки» -> «Склад 1 | Склад 2»): склеиваем подпись родителя с дочерней.
   */
  function mergeSplitHeaders(aoa, best) {
    var headers = best.headers.slice();
    var next = aoa[best.index + 1];
    var needMerge = false;
    if (next) {
      for (var c = 0; c < next.length; c++) {
        if (isBlank(next[c])) continue;
        var own = headers[c] || '';
        if (!own) { needMerge = true; break; }
        if (headers.filter(function (h) { return h === own; }).length > 1) { needMerge = true; break; }
      }
    }
    if (!needMerge) {
      // пустые ячейки шапки = объединённые ячейки, тянем значение слева
      var last = '';
      for (var i = 0; i < headers.length; i++) {
        if (!headers[i]) headers[i] = last;
        else last = headers[i];
      }
      best.headers = headers;
      return best;
    }
    for (var j = 0; j < next.length; j++) {
      var child = cellText(next[j]);
      var parent = headers[j] || '';
      if (child && parent && U.norm(child) !== U.norm(parent)) headers[j] = parent + ' — ' + child;
      else if (child) headers[j] = child;
    }
    return { index: best.index + 1, headers: headers, score: best.score + 4 };
  }

  function scoreLabel(label, field) {
    var n = U.norm(label);
    if (!n) return 0;
    var keys = FIELD_KEYWORDS[field] || [], sc = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (n === k) return 100 - i;
      if (n.indexOf(k) === 0) sc = Math.max(sc, 60 - i * 2);
      else if (n.indexOf(k) >= 0) sc = Math.max(sc, 35 - i);
    }
    return sc;
  }

  function numericShare(aoa, fromRow, col) {
    var nums = 0, total = 0;
    for (var r = fromRow; r < Math.min(aoa.length, fromRow + 200); r++) {
      var v = (aoa[r] || [])[col];
      if (isBlank(v)) continue;
      total++;
      if (typeof v === 'number') nums++;
      else {
        var p = U.parseQty(v);
        if (p.known && /\d/.test(String(v))) nums++;
      }
    }
    return total ? nums / total : 0;
  }

  function columnStats(aoa, fromRow, col) {
    var uniq = Object.create(null), chars = 0, count = 0;
    for (var r = fromRow; r < aoa.length; r++) {
      var t = cellText((aoa[r] || [])[col]);
      if (!t) continue;
      count++;
      chars += t.length;
      uniq[t = U.norm(t)] = 1;
      if (r > fromRow + 4000) break;
    }
    var u = Object.keys(uniq).length;
    return { count: count, uniq: u, avgLen: count ? chars / count : 0, ratio: u ? count / u : 1 };
  }

  /**
   * Определить, какая колонка чем является. Возвращает индексы (-1 — не найдено).
   */
  function detectMapping(headers, aoa, headerRow) {
    var dataFrom = headerRow + 1;
    var mapping = { name: -1, char: -1, qty: -1, sku: -1, price: -1, warehouse: -1, unit: -1, min: -1 };
    var nCols = 0;
    for (var i = 0; i < aoa.length && i < dataFrom + 50; i++) nCols = Math.max(nCols, (aoa[i] || []).length);
    var scored = {};
    for (var f in mapping) scored[f] = [];
    for (var c = 0; c < nCols; c++) {
      var label = headers[c] || '';
      for (var g in mapping) {
        var base = scoreLabel(label, g);
        if (g === 'qty') {
          var ns = numericShare(aoa, dataFrom, c);
          if (ns > 0.7) base += 14;
          if (ns > 0.95) base += 4;
        }
        if (g === 'warehouse') {
          var ws = columnStats(aoa, dataFrom, c);
          if (ws.uniq > 1 && ws.uniq <= 60 && ws.uniq * 8 < ws.count) base += 10;
        }
        if (g === 'char') {
          var cs = columnStats(aoa, dataFrom, c);
          if (cs.uniq > 1 && cs.uniq <= 400 && cs.avgLen < 40) base += 8;
        }
        if (g === 'name') {
          var nsz = columnStats(aoa, dataFrom, c);
          if (nsz.avgLen > 8) base += 12;
        }
        scored[g].push({ col: c, score: base });
      }
    }
    var taken = Object.create(null);
    var order = ['name', 'qty', 'char', 'price', 'warehouse', 'sku', 'unit', 'min'];
    for (var o = 0; o < order.length; o++) {
      var field = order[o];
      var list = scored[field].slice().sort(function (a, b) { return b.score - a.score; });
      for (var L = 0; L < list.length; L++) {
        if (list[L].score < 12) break;
        if (taken[list[L].col]) continue;
        mapping[field] = list[L].col;
        taken[list[L].col] = field;
        break;
      }
    }
    // Эвристика по содержимому, если колонок не хватает
    if (mapping.qty < 0) {
      for (var q = 0; q < nCols; q++) {
        if (taken[q]) continue;
        if (numericShare(aoa, dataFrom, q) > 0.8) { mapping.qty = q; taken[q] = 'qty'; break; }
      }
    }
    if (mapping.name < 0) {
      var bestName = -1, bestVal = 0;
      for (var m = 0; m < nCols; m++) {
        if (taken[m]) continue;
        var st = columnStats(aoa, dataFrom, m);
        var val = st.avgLen * 3 + Math.min(st.uniq, 5000);
        if (val > bestVal) { bestVal = val; bestName = m; }
      }
      if (bestName >= 0) { mapping.name = bestName; taken[bestName] = 'name'; }
    }
    if (mapping.char < 0) {
      var bestChar = -1, bestCharVal = 0;
      for (var h = 0; h < nCols; h++) {
        if (taken[h] || h === mapping.name) continue;
        var st2 = columnStats(aoa, dataFrom, h);
        if (!st2.count || st2.uniq < 2) continue;
        var v2 = st2.count / st2.uniq / (1 + st2.avgLen / 12);
        if (v2 > bestCharVal) { bestCharVal = v2; bestChar = h; }
      }
      if (bestChar >= 0) { mapping.char = bestChar; taken[bestChar] = 'char'; }
    }
    mapping.extra = [];
    for (var e = 0; e < nCols; e++) {
      var used = false;
      for (var kf in mapping) if (mapping[kf] === e) used = true;
      if (!used && columnStats(aoa, dataFrom, e).count > 0) mapping.extra.push(e);
    }
    return mapping;
  }

  /** Прочитать файл (File|ArrayBuffer|Uint8Array) -> набор листов со значениями. */
  function readWorkbook(input, fileName) {
    var XLSX = root.XLSX;
    if (!XLSX) throw new Error('XLSX не загружен');
    var opts = { type: 'array', cellDates: true, cellText: false, raw: true, codepage: 1251 };
    var data = input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) data = new Uint8Array(input);
    var wb = XLSX.read(data, opts);
    var sheets = [];
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var name = wb.SheetNames[i];
      var ws = wb.Sheets[name];
      if (!ws || !ws['!ref']) { sheets.push({ name: name, aoa: [], rows: 0, cols: 0 }); continue; }
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false, raw: true });
      var cols = 0;
      for (var r = 0; r < Math.min(aoa.length, 500); r++) cols = Math.max(cols, (aoa[r] || []).length);
      sheets.push({ name: name, aoa: aoa, rows: aoa.length, cols: cols });
    }
    return { fileName: fileName || '', sheets: sheets };
  }

  /**
   * Собрать датасет из матрицы значений.
   */
  function buildDataset(o) {
    var aoa = o.aoa, mapping = o.mapping, headerRow = o.headerRow;
    var headers = o.headers || [];
    var from = headerRow >= 0 ? headerRow + 1 : 0;
    var rows = [];
    var extras = (mapping.extra || []).slice();
    var skippedTotal = 0;
    var hdrSig = [];
    if (headerRow >= 0 && headers && headers.length) {
      var sigIdx = [mapping.name, mapping.char].filter(function (x) { return x >= 0; });
      if (sigIdx.length === 2) hdrSig.push(U.norm(headers[sigIdx[0]] || '') + '|' + U.norm(headers[sigIdx[1]] || ''));
    }
    var qtyIsInt = true, sum = 0, max = 0, min = Infinity;
    var uniqName = Object.create(null), uniqColor = Object.create(null), uniqWh = Object.create(null);
    for (var r = from; r < aoa.length; r++) {
      var a = aoa[r] || [];
      var name = cellText(mapping.name >= 0 ? a[mapping.name] : '');
      var char = cellText(mapping.char >= 0 ? a[mapping.char] : '');
      var qraw = mapping.qty >= 0 ? a[mapping.qty] : null;
      var q = U.parseQty(qraw);
      if (!name && !char && !q.text && qraw === null) continue;
      if (!name && !char) continue;
      var nrmName = U.norm(name);
      if (TOTAL_RE.test(nrmName) && !char) { skippedTotal++; continue; }
      if (hdrSig.length && hdrSig.indexOf(nrmName + '|' + U.norm(char)) >= 0) { skippedTotal++; continue; }
      var rec = {
        i: rows.length,
        n: name,
        c: char,
        q: q.num,
        qr: q.text || '',
        sku: cellText(mapping.sku >= 0 ? a[mapping.sku] : ''),
        p: mapping.price >= 0 ? U.parseQty(a[mapping.price]).num : null,
        pt: mapping.price >= 0 ? cellText(a[mapping.price]) : '',
        w: cellText(mapping.warehouse >= 0 ? a[mapping.warehouse] : ''),
        g: U.norm(name)
      };
      if (extras.length) rec.x = extras.map(function (c) { return cellText(a[c]); });
      if (Math.abs(rec.q % 1) > 1e-9) qtyIsInt = false;
      sum += rec.q;
      if (rec.q > max) max = rec.q;
      if (rec.q < min) min = rec.q;
      if (rec.g) uniqName[rec.g] = 1;
      if (rec.c) uniqColor[U.norm(rec.c)] = 1;
      if (rec.w) uniqWh[U.norm(rec.w)] = 1;
      rows.push(rec);
    }
    var columns = [];
    for (var f in mapping) {
      if (f === 'extra' || mapping[f] < 0) continue;
      columns.push({ key: f, idx: mapping[f], label: headers[mapping[f]] || labelFor(f) });
    }
    for (var x = 0; x < extras.length; x++) {
      columns.push({ key: 'x' + x, idx: extras[x], label: headers[extras[x]] || ('Колонка ' + (extras[x] + 1)), extra: true, pos: x });
    }
    return {
      kind: 'dataset',
      id: o.id || U.uid('ds'),
      fileName: o.fileName || '',
      fileSize: o.fileSize || 0,
      fileMtime: o.fileMtime || 0,
      sheetName: o.sheetName || '',
      importedAt: Date.now(),
      headerRow: headerRow,
      headersRaw: (headers || []).slice(),
      columns: columns,
      mapping: mapping,
      rows: rows,
      hasPrice: mapping.price >= 0,
      hasWarehouse: mapping.warehouse >= 0,
      qtyIsInt: qtyIsInt,
      qtyMax: max,
      qtyMin: min === Infinity ? 0 : min,
      stats: {
        rows: rows.length,
        uniqueNames: Object.keys(uniqName).length,
        uniqueColors: Object.keys(uniqColor).length,
        uniqueWarehouses: Object.keys(uniqWh).length,
        inStock: rows.filter(function (r) { return r.q > 0; }).length,
        outOfStock: rows.filter(function (r) { return !(r.q > 0); }).length,
        sumQty: sum,
        skippedTotal: skippedTotal
      }
    };
  }

  function labelFor(key) {
    return ({ name: 'Номенклатура', char: 'Характеристика (цвет)', qty: 'Остаток', sku: 'Артикул', price: 'Цена', warehouse: 'Склад', unit: 'Ед.', min: 'Резерв' })[key] || key;
  }

  /** Полный цикл: файл -> {датасет, варианты листов}. */
  function analyze(input, meta) {
    var book = readWorkbook(input, meta && meta.fileName);
    var sheets = book.sheets.map(function (s) {
      var det = detectHeader(s.aoa);
      var headers = det.index >= 0 ? det.headers : [];
      var mapping = det.index >= 0
        ? detectMapping(headers, s.aoa, det.index)
        : detectMapping([], s.aoa, -1);
      return {
        name: s.name, rows: s.aoa.length, cols: s.cols,
        headerRow: det.index, headers: headers, mapping: mapping,
        confidence: det.index >= 0 ? Math.round(Math.min(100, det.score)) : 0,
        estimated: s.aoa.length ? (s.aoa.length - det.index - 1) : 0
      };
    });
    // лист выбираем так: сначала «похоже на прайс» (шапка + колонка остатка), потом размер
    function rank(s) {
      var m = s.mapping || {};
      return (s.headerRow >= 0 ? 1000000 : 0) + (m.qty >= 0 ? 4000000 : 0) + (m.name >= 0 ? 2000000 : 0) + Math.min(s.estimated, 999999);
    }
    var pick = 0;
    for (var i = 1; i < sheets.length; i++) if (rank(sheets[i]) > rank(sheets[pick])) pick = i;
    var chosen = sheets[pick];
    var ds = buildDataset({
      aoa: book.sheets[pick].aoa,
      headers: chosen.headers,
      headerRow: chosen.headerRow,
      mapping: chosen.mapping,
      sheetName: book.sheets[pick].name,
      fileName: book.fileName,
      id: meta && meta.id,
      fileSize: meta && meta.fileSize,
      fileMtime: meta && meta.fileMtime
    });
    return { dataset: ds, sheets: sheets, picked: pick, book: book };
  }

  /** Пересобрать датасет с ручным выбором листа/шапки/колонок. */
  function rebuild(aoa, opts) {
    var det = { index: opts.headerRow, headers: opts.headers || [] };
    var mapping = opts.mapping;
    if (!mapping) mapping = detectMapping(det.headers, aoa, det.index);
    return buildDataset({
      aoa: aoa, headers: det.headers, headerRow: det.index, mapping: mapping,
      fileName: opts.fileName, fileSize: opts.fileSize, fileMtime: opts.fileMtime,
      sheetName: opts.sheetName, id: opts.id
    });
  }

  return {
    FIELD_KEYWORDS: FIELD_KEYWORDS,
    cellText: cellText,
    detectHeader: detectHeader,
    detectMapping: detectMapping,
    readWorkbook: readWorkbook,
    buildDataset: buildDataset,
    analyze: analyze,
    rebuild: rebuild,
    labelFor: labelFor
  };
});
