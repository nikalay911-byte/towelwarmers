/*
 * «Остатки Ника 41» — поисковый движок, фасетные фильтры, сортировка, группировка.
 */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.OST = root.OST || {};
  root.OST.search = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var U = (root.OST && root.OST.norm) ? root.OST : require('./util.js');

  var BIT = { query: 1, color: 2, warehouse: 4, stock: 8, qty: 16, price: 32, sku: 64, extra: 128 };

  /** Запрос -> токены. Поддержка "фразы в кавычках", -исключения. */
  function parseQuery(raw) {
    var src = String(raw || '');
    var toks = [], nots = [];
    var re = /"([^"]+)"|(\S+)/g, m;
    while ((m = re.exec(src))) {
      var phrase = m[1] !== undefined;
      var t = (phrase ? m[1] : m[2]).trim();
      if (!t) continue;
      var neg = !phrase && t[0] === '-';
      if (neg) t = t.slice(1);
      if (!t) continue;
      var variants = [];
      var n = U.norm(t);
      if (!n) continue;
      variants.push(n);
      if (!phrase) {
        var sw = U.norm(U.swapLayout(t));
        if (sw && sw !== n) variants.push(sw);
      }
      var item = { text: t, n: n, variants: variants, phrase: phrase, neg: neg };
      (neg ? nots : toks).push(item);
    }
    return { tokens: toks, nots: nots, empty: !toks.length && !nots.length };
  }

  /** Построить поисковый индекс по строкам (поиск по ЛЮБОЙ части слова = обычный подстроковый поиск). */
  function buildIndex(rows, onProgress) {
    return new Promise(function (resolve) {
      var i = 0, t0 = Date.now();
      function work() {
        t0 = Date.now();
        while (i < rows.length && Date.now() - t0 < 14) {
          var r = rows[i];
          r.cn = U.norm(r.c);
          r.nn = U.norm(r.n);
          r.wn = U.norm(r.w);
          r.sn = U.norm(r.sku);
          var blob = r.nn + ' \u0001 ' + r.cn + ' \u0001 ' + r.sn + ' \u0001 ' + r.wn + ' \u0001 ' + (r.pt || '');
          r.s = blob;
          i++;
        }
        if (onProgress) onProgress(i, rows.length);
        if (i < rows.length) (root.requestAnimationFrame || function (f) { setTimeout(f, 0); })(work);
        else resolve(rows.length);
      }
      work();
    });
  }

  function hitAny(hay, tok) {
    for (var i = 0; i < tok.variants.length; i++) if (hay.indexOf(tok.variants[i]) >= 0) return tok.variants[i];
    return null;
  }

  /** Совпадение строки с запросом + релевантность. */
  function score(row, query) {
    if (query.empty) return { ok: true, score: 0 };
    var total = 0;
    for (var i = 0; i < query.tokens.length; i++) {
      var tk = query.tokens[i];
      var found = false;
      for (var v = 0; v < tk.variants.length; v++) {
        var vzh = tk.variants[v];
        var inName = row.nn.indexOf(vzh);
        if (inName >= 0) {
          found = true;
          total += inName === 0 ? 60 : 34;
          if (row.nn === vzh) total += 60;
        }
        if (!found && row.cn.indexOf(vzh) >= 0) { found = true; total += 18; }
        if (!found && (row.sn.indexOf(vzh) >= 0 || row.wn.indexOf(vzh) >= 0 || (row.pt || '').indexOf(tk.n) >= 0)) { found = true; total += 12; }
      }
      if (!found && row.s.indexOf(tk.n) < 0) return { ok: false, score: 0 };
      if (!found) { found = true; total += 4; }
    }
    for (var j = 0; j < query.nots.length; j++) {
      var nt = query.nots[j];
      if (row.s.indexOf(nt.n) >= 0) return { ok: false, score: 0 };
    }
    return { ok: true, score: total };
  }

  function stockBucket(q, low) {
    if (q < 0) return 'neg';
    if (q <= 0) return 'zero';
    if (q <= low) return 'low';
    return 'in';
  }

  /**
   * Применить запрос + фильтры. Возвращает отфильтрованный список и счётчики фасетов
   * (счётчик фасета считается «если не учитывать сам фасет» — фильтры остаются живыми).
   */
  function apply(ds, st) {
    var rows = ds.rows, low = st.lowStock;
    var useColors = st.colors && st.colors.length, useWh = st.wh && st.wh.length;
    var useStock = st.stock && st.stock.length;
    var qlo = st.qtyMin === '' || st.qtyMin === null || isNaN(st.qtyMin) ? -Infinity : +st.qtyMin;
    var qhi = st.qtyMax === '' || st.qtyMax === null || isNaN(st.qtyMax) ? Infinity : +st.qtyMax;
    var plo = st.priceMin === '' || st.priceMin === null || isNaN(st.priceMin) ? -Infinity : +st.priceMin;
    var phi = st.priceMax === '' || st.priceMax === null || isNaN(st.priceMax) ? Infinity : +st.priceMax;
    var useQty = qlo > -Infinity || qhi < Infinity;
    var usePrice = plo > -Infinity || phi < Infinity;
    var useSku = !!st.hasSkuOnly;

    var colorSet = useColors ? index2set(st.colors) : null;
    var whSet = useWh ? index2set(st.wh) : null;
    var stockSet = useStock ? index2set(st.stock) : null;
    var query = st.query;

    var list = [];
    var fColor = Object.create(null), fWh = Object.create(null), fStock = Object.create(null);
    var sum = 0, pos = 0, minQty = Infinity, maxQty = -Infinity, minPrice = Infinity, maxPrice = -Infinity;
    var scores = st.sort === 'relevance' ? new Float64Array(rows.length) : null;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var sc = 0, fail = 0;
      if (!query.empty) {
        var res = score(r, query);
        if (!res.ok) fail |= BIT.query; else sc = res.score;
      }
      var cb = stockBucket(r.q, low);
      if (stockSet && !stockSet[cb]) fail |= BIT.stock;
      if (r.q < qlo || r.q > qhi) fail |= BIT.qty;
      var cn = r.cn || '';
      if (colorSet && cn && !colorSet[cn]) fail |= BIT.color;
      if (colorSet && !cn && st.colorsRequireValue) fail |= BIT.color;
      var wn = r.wn || '';
      if (whSet && !whSet[wn]) fail |= BIT.warehouse;
      if (usePrice && (r.p < plo || r.p > phi || r.p === null)) fail |= BIT.price;
      if (useSku && !r.sn) fail |= BIT.sku;
      if (st.onlyWithoutStock && r.q > 0) fail |= BIT.stock;

      if (scores) scores[i] = sc;
      if (r.q < minQty) minQty = r.q;
      if (r.q > maxQty) maxQty = r.q;
      if (r.p !== null && r.p !== undefined) {
        if (r.p < minPrice) minPrice = r.p;
        if (r.p > maxPrice) maxPrice = r.p;
      }

      if (!fail) { list.push(i); sum += r.q; if (r.q > 0) pos++; }

      // фасеты: строка попадает в счётчик, если проходит ВСЁ, кроме самого этого фасета
      if ((fail & ~BIT.color) === 0) { fColor[cn || ''] = (fColor[cn || ''] || 0) + 1; }
      if ((fail & ~BIT.warehouse) === 0 && wn) fWh[wn] = (fWh[wn] || 0) + 1;
      if ((fail & ~BIT.stock) === 0) fStock[cb] = (fStock[cb] || 0) + 1;
    }

    return {
      list: list,
      scores: scores,
      facets: { color: fColor, warehouse: fWh, stock: fStock },
      ranges: {
        qty: { min: minQty === Infinity ? 0 : minQty, max: maxQty === -Infinity ? 0 : maxQty },
        price: { min: minPrice === Infinity ? 0 : minPrice, max: maxPrice === -Infinity ? 0 : maxPrice }
      },
      agg: { sum: sum, pos: pos, matched: list.length }
    };
  }

  function index2set(arr) {
    var o = Object.create(null);
    for (var i = 0; i < arr.length; i++) o[arr[i]] = 1;
    return o;
  }

  function valueOf(row, key) {
    switch (key) {
      case 'name': return row.n;
      case 'char': return row.c;
      case 'qty': return row.q;
      case 'price': return row.p === null || row.p === undefined ? -Infinity : row.p;
      case 'sku': return row.sku;
      case 'warehouse': return row.w;
      default:
        if (key.slice(0, 1) === 'x') {
          var pos = +key.slice(1);
          return row.x ? row.x[pos] : '';
        }
        return '';
    }
  }

  function sortRows(rows, list, key, dir, scores) {
    var mult = dir === 'desc' ? -1 : 1;
    var numeric = key === 'qty' || key === 'price';
    var out = list.slice();
    if (key === 'relevance') {
      out.sort(function (a, b) {
        var d = (scores[b] - scores[a]) || (rows[b].q - rows[a].q);
        return d || (a - b);
      });
      return out;
    }
    if (key === 'default') { out.sort(function (a, b) { return a - b; }); return out; }
    out.sort(function (a, b) {
      var va = valueOf(rows[a], key), vb = valueOf(rows[b], key);
      var d;
      if (numeric) d = (va === vb ? 0 : va < vb ? -1 : 1);
      else d = U.cmpStr(String(va || ''), String(vb || ''));
      if (!d) d = a - b;
      return d * mult;
    });
    return out;
  }

  /** Группировка по номенклатуре: сумма остатков + список характеристик. */
  function groupRows(rows, list, opts) {
    var map = Object.create(null), order = [];
    for (var i = 0; i < list.length; i++) {
      var r = rows[list[i]];
      var key = r.g || U.norm(r.n);
      if (!key) key = '#' + list[i];
      var g = map[key];
      if (!g) {
        g = map[key] = { key: key, name: r.n, total: 0, count: 0, items: [], colors: Object.create(null), warehouses: Object.create(null), min: Infinity, max: -Infinity, firstIdx: list[i], priceSum: 0, priceN: 0 };
        order.push(g);
      }
      g.total += r.q;
      g.count++;
      g.items.push(list[i]);
      if (r.cn) g.colors[r.cn] = (g.colors[r.cn] || 0) + 1;
      if (r.wn) g.warehouses[r.wn] = 1;
      if (r.q < g.min) g.min = r.q;
      if (r.q > g.max) g.max = r.q;
      if (r.p !== null && r.p !== undefined && isFinite(r.p)) { g.priceSum += r.p; g.priceN++; }
    }
    var groups = order;
    var sort = (opts && opts.sort) || 'name';
    var dir = (opts && opts.dir) === 'desc' ? -1 : 1;
    groups.sort(function (a, b) {
      var d;
      if (sort === 'total') d = a.total - b.total;
      else if (sort === 'count') d = a.count - b.count;
      else if (sort === 'price') d = (a.priceN ? a.priceSum / a.priceN : 0) - (b.priceN ? b.priceSum / b.priceN : 0);
      else d = U.cmpStr(a.name, b.name);
      if (!d) d = a.firstIdx - b.firstIdx;
      return d * dir;
    });
    for (var k = 0; k < groups.length; k++) {
      var g2 = groups[k];
      g2.colorList = Object.keys(g2.colors).sort(function (x, y) { return g2.colors[y] - g2.colors[x] || U.cmpStr(x, y); });
      g2.warehouses = Object.keys(g2.warehouses);
      delete g2.colors;
    }
    return groups;
  }

  function stats(rows, list) {
    var sum = 0, pos = 0, zero = 0, neg = 0, max = 0;
    for (var i = 0; i < list.length; i++) {
      var q = rows[list[i]].q;
      sum += q;
      if (q > 0) pos++; else if (q < 0) neg++; else zero++;
      if (q > max) max = q;
    }
    return { sum: sum, pos: pos, zero: zero, neg: neg, max: max, matched: list.length };
  }

  return {
    parseQuery: parseQuery, buildIndex: buildIndex, score: score, apply: apply,
    sortRows: sortRows, groupRows: groupRows, stockBucket: stockBucket, stats: stats,
    valueOf: valueOf, BIT: BIT
  };
});
