/*
 * Извлечение цены со страницы магазина. Внедряется в открытую вкладку (chrome.scripting),
 * работает с уже отрисованным DOM (подходит и для сайтов на JS). Ничего не нажимает и не отправляет.
 *
 * Порядок стратегий:
 *   1. CSS-селектор, заданный для ссылки вручную;
 *   2. если задан «якорь» (артикул/фрагмент названия) и страница — список товаров: цена в карточке рядом с якорем;
 *   3. JSON-LD schema.org Product/Offer (один товар или товар с нашим артикулом);
 *   4. микроразметка itemprop="price";
 *   5. meta product:price:amount / og:price:amount;
 *   6. цена рядом с артикулом;
 *   7. эвристика: самый крупный видимый элемент «price» в блоке товара (без старой цены, рассрочки, похожих товаров).
 */
(function (root) {
  'use strict';

  var PRICE_RE = /(\d{1,3}(?:[ \u00a0\u2009\u202f'](?=\d{3})\d{3})+|\d+)(?:[.,](\d{1,2}))?(?!\d)/g;
  function parsePrice(text) {
    if (typeof text === 'number') return isFinite(text) && text > 0 ? text : null;
    var s = String(text == null ? '' : text);
    PRICE_RE.lastIndex = 0;
    var m;
    while ((m = PRICE_RE.exec(s))) {
      var after = s.slice(m.index + m[0].length, m.index + m[0].length + 3);
      if (/^\s*%/.test(after)) continue;
      var v = Number(m[1].replace(/[^\d]/g, '') + (m[2] ? '.' + m[2] : ''));
      if (v >= 50 && v <= 50000000) return Math.round(v * 100) / 100;
    }
    return null;
  }
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[\u00a0\u2009\u202f\s]+/g, ' ').trim();
  }

  var BLOCK_RE = /captcha|капч|cf-chl|just a moment|checking your browser|проверка браузера|проверяем браузер|ddos-guard|превышени[ея] (?:числа|количества|лимита) запросов|слишком много запросов|too many requests|access denied|доступ (?:запрещ|огранич)|подтвердите,? что вы не робот|вы не робот|are you a robot|attention required|security check|smartcaptcha/i;
  var NOTFOUND_RE = /(^|\D)404(\D|$)|страница не найдена|page not found|товар не найден|не существует|снят с продажи/i;
  var BAD_CLASS_RE = /old|prev|was|cross|strike|through|economy|save|saving|discount|diff|credit|month|bonus|install|rassroch|compare|cashback|delivery|dostav|cart-total|basket|minicart|header|footer|filter|range|slider-price|price-?filter/i;
  var RELATED_RE = /similar|related|recommend|viewed|analog|accessor|carousel|swiper|slick|upsell|cross-?sell|also|похож|together|bundle|mini-?card/i;
  var PRICEISH_RE = /price|cost|cena|tsena|sum|amount/i;

  function cls(el) {
    if (!el || el.nodeType !== 1) return '';
    var c = el.getAttribute('class') || '';
    return c + ' ' + (el.id || '') + ' ' + (el.getAttribute('itemprop') || '') + ' ' + (el.getAttribute('data-qa') || el.getAttribute('data-testid') || '');
  }
  function styleOf(el) {
    try { var w = el.ownerDocument.defaultView; return w && w.getComputedStyle ? w.getComputedStyle(el) : null; } catch (e) { return null; }
  }
  function isHidden(el) {
    for (var e = el, i = 0; e && e.nodeType === 1 && i < 12; e = e.parentElement, i++) {
      if (e.hidden || e.getAttribute('aria-hidden') === 'true') return true;
      var st = styleOf(e);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
    }
    return false;
  }
  function isStruck(el) {
    for (var e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i++) {
      if (/^(S|DEL|STRIKE)$/.test(e.tagName)) return true;
      var st = styleOf(e);
      if (st && /line-through/.test(st.textDecorationLine || st.textDecoration || '')) return true;
    }
    return false;
  }
  function badAncestor(el, re, depth) {
    for (var e = el, i = 0; e && e.nodeType === 1 && i < depth; e = e.parentElement, i++) {
      if (e.tagName === 'BODY' || e.tagName === 'MAIN') return false;
      if (re.test(cls(e))) return true;
      if (/^(HEADER|FOOTER|NAV|ASIDE)$/.test(e.tagName)) return true;
    }
    return false;
  }
  function fontSize(el) { var st = styleOf(el); var v = st ? parseFloat(st.fontSize) : NaN; return isFinite(v) ? v : 0; }
  function textOf(el) { return (el.getAttribute && el.getAttribute('content')) || el.textContent || ''; }

  /** Ценовые элементы внутри scope: класс/id/itemprop похож на «price», в тексте — цена. */
  function priceCandidates(scope, opts) {
    opts = opts || {};
    var out = [];
    var els = scope.querySelectorAll('[class*="price" i], [id*="price" i], [itemprop="price"], [data-price], [class*="cost" i], [class*="cena" i], [class*="tsena" i]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var c = cls(el);
      if (!PRICEISH_RE.test(c) && !el.hasAttribute('data-price')) continue;
      // берём «листья»: если внутри есть ещё ценовой элемент — разберём его
      var inner = el.querySelector('[class*="price" i], [itemprop="price"]');
      if (inner && parsePrice(textOf(inner)) != null && el.getAttribute('itemprop') !== 'price') continue;
      if (BAD_CLASS_RE.test(c)) continue;
      var txt = el.getAttribute('itemprop') === 'price' ? textOf(el) : (el.getAttribute('data-price') || el.textContent || '');
      if (txt.length > 80) continue;
      if (/мес|month|бонус|балл|кешбэк|cashback|скидк|эконом|выгод/i.test(txt)) continue;
      var v = parsePrice(txt);
      if (v == null) continue;
      if (isStruck(el) || isHidden(el)) continue;
      if (badAncestor(el, BAD_CLASS_RE, 3)) continue;
      if (!opts.allowRelated && badAncestor(el, RELATED_RE, 14)) continue;
      out.push({ el: el, price: v });
    }
    return out;
  }
  function domIndex(doc, el) {
    var all = doc.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) if (all[i] === el) return i;
    return 1e9;
  }
  function commonDepth(a, b, max) {
    if (!a || !b) return Infinity;
    for (var e = a, i = 0; e && i < max; e = e.parentElement, i++) if (e.contains(b)) return i;
    return Infinity;
  }
  function bestCandidate(doc, cands) {
    if (!cands.length) return null;
    var h1 = doc.querySelector('h1');
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var near = commonDepth(h1, c.el, 8);
      var score = fontSize(c.el) * 10 + (near < 8 ? (8 - near) * 15 : 0) + (/current|actual|new|final|sale|main/i.test(cls(c.el)) ? 30 : 0) - i * 0.01;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /* ---------- JSON-LD ---------- */
  function jsonLdProducts(doc) {
    var out = [];
    var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    var visit = function (n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      var t = n['@type'];
      var isProd = t === 'Product' || (Array.isArray(t) && t.indexOf('Product') >= 0) || t === 'ProductGroup';
      if (isProd) out.push(n);
      if (n['@graph']) visit(n['@graph']);
      if (n.itemListElement) visit(n.itemListElement);
      if (n.item && typeof n.item === 'object') visit(n.item);
      if (n.hasVariant) visit(n.hasVariant);
    };
    for (var i = 0; i < scripts.length; i++) {
      try { visit(JSON.parse(scripts[i].textContent.replace(/[\u0000-\u001f]+/g, ' '))); } catch (e) { /* битый JSON-LD — пропускаем */ }
    }
    return out;
  }
  function offerPrice(p) {
    var offers = p.offers;
    if (!offers) return null;
    var list = Array.isArray(offers) ? offers : [offers];
    var prices = [], avail = null;
    list.forEach(function (o) {
      if (!o) return;
      var v = parsePrice(o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : (o.priceSpecification && o.priceSpecification.price)));
      if (v != null) prices.push(v);
      if (o.availability && !avail) avail = String(o.availability);
    });
    if (!prices.length) return null;
    return { price: Math.min.apply(null, prices), availability: avail };
  }
  function productMatches(p, anchorN) {
    if (!anchorN) return false;
    var hay = norm([p.sku, p.mpn, p.productID, p.gtin13, p.name, p.url].join(' '));
    return hay.indexOf(anchorN) >= 0;
  }

  /* ---------- микроразметка ---------- */
  function microdataProducts(doc) {
    var out = [];
    var prods = doc.querySelectorAll('[itemtype*="schema.org/Product" i]');
    for (var i = 0; i < prods.length; i++) {
      var pe = prods[i].querySelector('[itemprop="price"], [itemprop="lowPrice"]');
      if (!pe) continue;
      var v = parsePrice(textOf(pe));
      if (v == null) continue;
      var av = prods[i].querySelector('[itemprop="availability"]');
      out.push({ el: prods[i], price: v, availability: av ? (av.getAttribute('href') || av.getAttribute('content') || av.textContent) : null });
    }
    return out;
  }

  /* ---------- якорь (артикул или фрагмент названия) ---------- */
  function anchorElements(doc, anchorN) {
    if (!anchorN || !doc.body) return [];
    var out = [];
    var walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
    var n;
    while ((n = walker.nextNode())) {
      var p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      if (norm(n.nodeValue).indexOf(anchorN) >= 0) out.push(p);
    }
    // название часто разбито на несколько узлов — проверяем ссылки/заголовки целиком
    if (!out.length) {
      var els = doc.body.querySelectorAll('a, h1, h2, h3, h4, [class*="name" i], [class*="title" i]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].textContent.length < 400 && norm(els[i].textContent).indexOf(anchorN) >= 0) out.push(els[i]);
      }
    }
    if (/^[\w-]{4,}$/.test(anchorN)) {
      var links = doc.body.querySelectorAll('a[href]');
      for (var j = 0; j < links.length; j++) if (norm(links[j].getAttribute('href')).indexOf(anchorN) >= 0) out.push(links[j]);
    }
    return out;
  }
  function priceNearAnchor(doc, anchorN, allowRelated) {
    var anchors = anchorElements(doc, anchorN);
    for (var i = 0; i < anchors.length; i++) {
      if (isHidden(anchors[i])) continue;
      var e = anchors[i];
      for (var depth = 0; e && e !== doc.body && depth < 9; e = e.parentElement, depth++) {
        var c = priceCandidates(e, { allowRelated: allowRelated });
        if (c.length) {
          // в контейнере с одной ценой — она; если цен несколько (старая/новая) — главная по эвристике
          var b = c.length === 1 ? c[0] : bestCandidate(doc, c);
          return { price: b.price, el: b.el, container: e };
        }
      }
    }
    return null;
  }

  function availabilityText(s) {
    s = norm(s);
    if (!s) return null;
    if (/outofstock|нет в наличии|нет на складе|отсутствует|распродан|снят с/.test(s)) return 'Нет в наличии';
    if (/preorder|backorder|под заказ|предзаказ|ожидается/.test(s)) return 'Под заказ';
    if (/instock|limitedavailability|в наличии|есть на складе|в магазине|на складе/.test(s)) return 'В наличии';
    return null;
  }
  function nearbyAvailability(el) {
    for (var e = el, i = 0; e && i < 6; e = e.parentElement, i++) {
      var a = availabilityText((e.textContent || '').slice(0, 3000));
      if (a) return a;
    }
    return null;
  }

  function extract(doc, opts) {
    opts = opts || {};
    var article = norm(opts.article);
    var anchor = norm(opts.anchor);
    var body = doc.body;
    var bodyText = body ? (body.innerText || body.textContent || '') : '';
    var title = (doc.title || '').trim();
    var h1 = doc.querySelector('h1');
    var url = doc.location ? String(doc.location.href) : '';
    var res = {
      url: url,
      title: (h1 && h1.textContent.trim()) || title,
      price: null, method: null, availability: null, blocked: null, notFound: false,
      articleFound: article ? (norm(bodyText).indexOf(article) >= 0 || norm(url).indexOf(article) >= 0) : null,
      textLength: bodyText.length
    };
    var done = function (price, method, el, avail) {
      res.price = price; res.method = method;
      res.availability = availabilityText(avail) || (el ? nearbyAvailability(el) : null);
      return res;
    };

    // 1. ручной селектор
    if (opts.selector) {
      try {
        var sel = doc.querySelector(opts.selector);
        if (sel) { var sv = parsePrice(textOf(sel)); if (sv != null) return finish(done(sv, 'selector', sel)); }
      } catch (e) { res.selectorError = String(e && e.message || e); }
    }
    // 2. якорь задан явно → это, скорее всего, страница-список: ищем карточку с якорем
    if (anchor) {
      var near = priceNearAnchor(doc, anchor, true);
      if (near) return finish(done(near.price, 'anchor', near.container));
      res.anchorFound = anchorElements(doc, anchor).length > 0;
      return finish(res);
    }
    // 3. JSON-LD
    var prods = jsonLdProducts(doc).map(function (p) { var o = offerPrice(p); return o ? { p: p, price: o.price, availability: o.availability } : null; }).filter(Boolean);
    if (prods.length) {
      var pick = prods.length === 1 ? prods[0] : (prods.filter(function (x) { return productMatches(x.p, article); })[0] || null);
      if (!pick && prods.length > 1) {
        var uniq = prods.map(function (x) { return x.price; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
        if (uniq.length === 1) pick = prods[0];
      }
      if (pick) return finish(done(pick.price, 'json-ld', null, pick.availability));
    }
    // 4. микроразметка
    var md = microdataProducts(doc).filter(function (x) { return !badAncestor(x.el.parentElement, RELATED_RE, 14); });
    if (md.length) {
      var mp = md.length === 1 ? md[0] : (article ? md.filter(function (x) { return norm(x.el.textContent).indexOf(article) >= 0; })[0] : null);
      if (mp) return finish(done(mp.price, 'microdata', mp.el, mp.availability));
    }
    // 5. meta
    var meta = doc.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"]');
    if (meta) { var mv = parsePrice(meta.getAttribute('content')); if (mv != null) return finish(done(mv, 'meta', null)); }
    // 6. рядом с артикулом
    if (article && res.articleFound) {
      var na = priceNearAnchor(doc, article, false);
      if (na) return finish(done(na.price, 'article', na.container));
    }
    // 7. эвристика
    var b = bestCandidate(doc, priceCandidates(body || doc));
    if (b) return finish(done(b.price, 'heuristic', b.el));
    return finish(res);

    function finish(r) {
      var probe = title + ' \n' + bodyText.slice(0, 4000);
      var challenge = doc.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification, iframe[src*="captcha" i], iframe[src*="challenge" i], [class*="smart-captcha" i], #captcha, .captcha');
      if (r.price == null) {
        if (BLOCK_RE.test(title) || ((challenge || BLOCK_RE.test(probe)) && bodyText.length < 6000)) {
          var m = probe.match(BLOCK_RE);
          r.blocked = m ? m[0] : 'капча';
        } else if (NOTFOUND_RE.test(title) || (NOTFOUND_RE.test(bodyText.slice(0, 1500)) && bodyText.length < 8000)) {
          r.notFound = true;
        }
      }
      return r;
    }
  }

  var api = { extract: extract, parsePrice: parsePrice, norm: norm };
  root.__pmExtract = extract;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
