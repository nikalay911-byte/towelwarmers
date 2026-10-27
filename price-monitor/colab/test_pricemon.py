"""Тесты pricemon: python -m unittest price-monitor/colab/test_pricemon.py (нужны requests, beautifulsoup4, lxml, pandas, openpyxl)."""
import http.server
import os
import random
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pricemon as pm  # noqa: E402


class Core(unittest.TestCase):
    def test_parse_price(self):
        self.assertEqual(pm.parse_price("23 715 ₽"), 23715)
        self.assertEqual(pm.parse_price("23\u00a0715 руб."), 23715)
        self.assertEqual(pm.parse_price("Цена: 1\u2009999,90"), 1999.9)
        self.assertEqual(pm.parse_price("-15% 27 900"), 27900)
        self.assertIsNone(pm.parse_price("нет"))

    def test_deviation(self):
        self.assertEqual(pm.deviation(23715, 27900), -15.0)
        self.assertEqual(pm.deviation(25800, 27900), -7.53)
        self.assertEqual(pm.deviation(31000, 34100), -9.09)
        self.assertFalse(pm.is_dumping(27900, 27900))
        self.assertTrue(pm.is_dumping(27800, 27900))
        self.assertFalse(pm.is_dumping(27800, 27900, 1))

    def test_domains(self):
        self.assertEqual(pm.site_of("https://tver.santehnica.ru/x"), "santehnica.ru")
        self.assertTrue(pm.is_excluded("https://www.comfysan.ru/a", pm.DEFAULT_EXCLUDED))
        self.assertFalse(pm.is_excluded("https://notcomfysan.ru/", pm.DEFAULT_EXCLUDED))

    def test_queue_interleaves_and_dedups(self):
        P = pm.Position
        L = pm.Link
        pos = [P("A", "1", 100, [L("https://a.ru/1"), L("https://a.ru/2"), L("https://a.ru/3"), L("https://b.ru/1"), L("https://comfysan.ru/x")]),
               P("B", "2", 100, [L("https://b.ru/2"), L("https://c.ru/1"), L("https://a.ru/1", anchor="2")])]
        q = pm.build_queue(pos, pm.Settings().normalized(), random.Random(1))
        urls = [u for u, _ in q]
        self.assertEqual(len(urls), 6, "a.ru/1 открывается один раз для двух позиций; comfysan.ru исключён")
        sites = [pm.site_of(u) for u in urls]
        self.assertTrue(all(sites[i] != sites[i + 1] for i in range(len(sites) - 2)), sites)

    def test_import_formats(self):
        tsv = "Товар A\t018160\t27 900\thttps://a.ru/1\nТовар A\t018160\t27900\thttps://b.ru/1\tEC-3\nТовар B\t018191\t22500\thttps://a.ru/2"
        ps = pm.load_positions(tsv)
        self.assertEqual(len(ps), 2)
        self.assertEqual(len(ps[0].links), 2)
        self.assertEqual(ps[0].links[1].anchor, "EC-3")
        back = pm.load_positions(pm.positions_to_csv(pm.SAMPLE_POSITIONS))
        self.assertEqual([p.article for p in back], ["018160", "018184", "018443", "018191"])
        self.assertEqual(sum(len(p.links) for p in back), 14)
        # CSV из расширения («Выгрузить позиции»)
        ext = "\ufeffНаименование;Артикул;Наша цена;Ссылка;Якорь;CSS-селектор\r\nX;018160;27900;https://a.ru/1;;.price\r\n"
        p = pm.load_positions(ext)[0]
        self.assertEqual((p.article, p.our_price, p.links[0].selector), ("018160", 27900, ".price"))

    def test_xlsx_import(self):
        import pandas as pd
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "p.xlsx")
            pd.DataFrame([["Товар", 18160, 27900, "https://a.ru/1"]], columns=["Наименование", "Артикул", "Наша цена", "Ссылка"]).to_excel(f, index=False)
            p = pm.load_positions(f)[0]
            self.assertEqual(p.article, "18160")
            self.assertEqual(p.our_price, 27900)


class Extract(unittest.TestCase):
    def test_jsonld(self):
        html = """<html><head><script type="application/ld+json">{"@graph":[{"@type":"Product","sku":"018160","offers":{"price":"23715.00","availability":"https://schema.org/InStock"}}]}</script></head>
        <body><h1>Alto-K 018160</h1><div class="price">27 900 ₽</div></body></html>"""
        r = pm.extract(html, article="018160")
        self.assertEqual((r["price"], r["method"], r["availability"], r["article_found"]), (23715, "json-ld", "В наличии", True))

    def test_heuristic_skips_old_credit_related(self):
        html = """<body><header><span class="cart-price">0 ₽</span></header><div class="product"><h1>Alto-K 018160</h1>
        <div class="product-prices"><span class="price-old">27 900 ₽</span><span class="price-current">23 715 ₽</span></div>
        <div class="credit-price">от 1 976 ₽/мес</div><div class="stock">В наличии</div></div>
        <div class="similar-products"><span class="price">18 650 ₽</span></div></body>"""
        r = pm.extract(html, article="018160")
        self.assertEqual(r["price"], 23715)
        self.assertEqual(r["availability"], "В наличии")

    def test_santehtop_like_markup(self):
        # как на santehtop: «-15%», старая цена, новая цена отдельными элементами
        html = """<body><h1>Comfysan Alto-K EC-3 120/12 018160</h1><div class="card"><b>Есть в наличии</b>
        <div class="prices"><span class="discount">-15%</span><del class="price">27 900</del><span class="price">23 715</span></div></div></body>"""
        self.assertEqual(pm.extract(html, article="018160")["price"], 23715)

    def test_anchor_on_list(self):
        html = """<body><h1>Поиск</h1>
        <div class="card"><a href="/p/alto-ec-4-018627/">Alto EC-4 120/18, оружейная сталь, гальваника</a><div class="price">29 000 руб.</div></div>
        <div class="card"><a href="/p/alto-k-ec-4-018184/">Alto-K EC-4 120/18, оружейная сталь, гальваника</a><div class="price">31 000 руб.</div></div>
        <div class="card"><a href="/p/alto-k-ec-4-018443/">Alto-K EC-4 120/18, золото, гальваника</a><div class="price">31 500 руб.</div></div></body>"""
        self.assertEqual(pm.extract(html, anchor="018184")["price"], 31000)
        self.assertEqual(pm.extract(html, anchor="Alto-K EC-4 120/18, золото")["price"], 31500)
        miss = pm.extract(html, anchor="999999")
        self.assertIsNone(miss["price"])
        self.assertFalse(miss["anchor_found"])

    def test_related_block_with_anchor(self):
        html = """<body><h1>Alto-K EC-2 белый</h1><div class="price">18 030 ₽</div><div class="related-products">
        <div class="product-thumb"><a>Альто-К (Alto-K) EC-3 120/12, оружейная сталь, гальвани</a><p class="price">25 800 ₽</p></div></div></body>"""
        self.assertEqual(pm.extract(html, anchor="EC-3 120/12, оружейная сталь, гальвани")["price"], 25800)
        self.assertEqual(pm.extract(html)["price"], 18030)

    def test_blocked_notfound_mismatch(self):
        self.assertTrue(pm.extract("<title>Just a moment...</title><body>Checking your browser</body>")["blocked"])
        self.assertTrue(pm.extract("<body><h1>Превышение числа запросов</h1></body>")["blocked"])
        r = pm.extract('<body><h1>Товар</h1><div class="price">25 110 ₽</div><footer>protected by reCAPTCHA</footer></body>')
        self.assertEqual((r["price"], r["blocked"]), (25110, None))
        self.assertTrue(pm.extract("<title>404 — Страница не найдена</title><body>Ошибка</body>")["not_found"])
        r = pm.extract('<body><h1>Alto-K 018436 никель</h1><div class="price">23 715 ₽</div></body>',
                       url="https://www.santehtop.ru/comfysan-alto-k-018436/", article="018160")
        self.assertEqual((r["price"], r["article_found"]), (23715, False))

    def test_selector_and_microdata(self):
        self.assertEqual(pm.extract('<body><span id="pp">12 345</span><div class="price">99 999</div></body>', selector="#pp")["price"], 12345)
        md = '<body><div itemscope itemtype="http://schema.org/Product"><div itemprop="offers"><meta itemprop="price" content="22500"><link itemprop="availability" href="http://schema.org/OutOfStock"></div></div></body>'
        r = pm.extract(md)
        self.assertEqual((r["price"], r["method"], r["availability"]), (22500, "microdata", "Нет в наличии"))


class FakeFetcher:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get(self, url):
        self.calls.append(url)
        v = self.pages[url]
        if isinstance(v, list):  # последовательность ответов (для повтора после 500)
            v = v.pop(0)
        if isinstance(v, Exception):
            raise v
        return v

    def close(self):
        pass


def prod(price, art):
    return f'<body><h1>Comfysan {art}</h1><div class="price">{price} ₽</div></body>'


class Run(unittest.TestCase):
    def positions(self):
        P, L = pm.Position, pm.Link
        return [P("EC-3", "018160", 27900, [L("https://a.ru/1"), L("https://b.ru/1"), L("https://c.ru/1"), L("https://comfysan.ru/1")]),
                P("Stella", "018191", 22500, [L("https://a.ru/2"), L("https://b.ru/2"), L("https://d.ru/1")])]

    def test_full_run_pauses_block_retry(self):
        f = FakeFetcher({
            "https://a.ru/1": [(500, "err", "https://a.ru/1"), (200, prod("23 715", "018160"), "https://a.ru/1")],
            "https://b.ru/1": (429, "<title>Too Many Requests</title>", "https://b.ru/1"),
            "https://b.ru/2": (200, prod("20 000", "018191"), "https://b.ru/2"),
            "https://c.ru/1": (200, prod("27 900", "018160"), "https://c.ru/1"),
            "https://a.ru/2": (200, prod("22 500", "018191"), "https://a.ru/2"),
            "https://d.ru/1": (404, "<title>404</title>", "https://d.ru/1"),
        })
        pauses, logs = [], []
        res = pm.run(self.positions(), pm.Settings(min_pause=5, max_pause=10), log=logs.append, sleep=pauses.append,
                     fetcher=f, rnd=random.Random(7))
        self.assertNotIn("https://comfysan.ru/1", f.calls)
        self.assertTrue(all(5 <= p <= 10 for p in pauses), pauses)
        self.assertEqual(len(pauses), len(f.calls) - 1, "перед каждым запросом, кроме первого, — пауза")
        by = {r.link.url: r for r in res}
        self.assertEqual((by["https://a.ru/1"].status, by["https://a.ru/1"].price), ("ok", 23715), "повтор после 500")
        self.assertEqual(f.calls.count("https://a.ru/1"), 2)
        self.assertEqual(f.calls[-1], "https://a.ru/1", "повтор — в конце очереди")
        self.assertEqual(by["https://b.ru/1"].status, "blocked")
        if f.calls.index("https://b.ru/1") < (f.calls.index("https://b.ru/2") if "https://b.ru/2" in f.calls else 99):
            self.assertEqual(by["https://b.ru/2"].status, "skipped", "после блока сайт не трогаем")
            self.assertNotIn("https://b.ru/2", f.calls)
        self.assertEqual(by["https://d.ru/1"].status, "notfound")
        self.assertEqual(by["https://comfysan.ru/1"].status, "excluded")
        rows = pm.report_rows(res)
        self.assertNotIn("comfysan.ru", " ".join(r["Магазин демпинг"] for r in rows))
        a1 = next(r for r in rows if r["Ссылка на магазин конкурента"] == "https://a.ru/1")
        self.assertEqual((a1["Цена товара"], a1["Разница в цене в %"], a1["Магазин демпинг"]), (23715, -15.0, "a.ru — Да"))
        c1 = next(r for r in rows if r["Ссылка на магазин конкурента"] == "https://c.ru/1")
        self.assertEqual(c1["Магазин демпинг"], "c.ru — Нет")
        csv = pm.report_csv(res)
        self.assertTrue(csv.startswith("\ufeffТовар;Артикул;Наша цена;Цена товара;Разница в цене в %;Магазин демпинг;Ссылка на магазин конкурента"))
        self.assertIn("23715.0;-15,0;a.ru — Да;https://a.ru/1", csv)
        with tempfile.TemporaryDirectory() as d:
            path = pm.save_xlsx(res, os.path.join(d, "r.xlsx"))
            import pandas as pd
            x = pd.read_excel(path, sheet_name=None)
            self.assertEqual(list(x), ["Конкуренты", "Сводка"])
            self.assertEqual(list(x["Конкуренты"].columns), pm.REPORT_COLUMNS)
        pm.styled(res).to_html()  # отрисовка для Colab не падает

    def test_domain_gap(self):
        f = FakeFetcher({"https://a.ru/1": (200, prod("1 000", "1"), "u"), "https://a.ru/2": (200, prod("1 000", "1"), "u")})
        pauses = []
        pm.run([pm.Position("X", "1", 1000, [pm.Link("https://a.ru/1"), pm.Link("https://a.ru/2")])],
               pm.Settings(min_pause=1, max_pause=2, domain_gap=30), log=lambda m: None, sleep=pauses.append, fetcher=f)
        self.assertGreater(pauses[0], 29, "один сайт — не чаще раза в 30 с")

    def test_run_auto_thread_and_stop(self):
        pages = {f"https://s{i}.ru/1": (200, prod("1 000", "1"), f"https://s{i}.ru/1") for i in range(4)}
        pos = [pm.Position("X", "1", 2000, [pm.Link(u) for u in pages])]
        st = pm.Settings(min_pause=0, max_pause=0, use_browser_for="s0.ru")  # с браузером → отдельный поток
        main = threading.get_ident()
        seen = []

        class F(FakeFetcher):
            def get(self, url):
                seen.append(threading.get_ident())
                return super().get(url)
        res = pm.run_auto(pos, st, log=lambda m: None, fetcher=F(dict(pages)), sleep=lambda s: None)
        self.assertEqual([r.status for r in res], ["ok"] * 4)
        self.assertTrue(seen and all(t != main for t in seen), "Playwright-режим идёт не в главном потоке")
        res = pm.run_auto(pos, pm.Settings(min_pause=0, max_pause=0), log=lambda m: None, fetcher=FakeFetcher(dict(pages)))
        self.assertEqual(sum(r.status == "ok" for r in res), 4)
        stop = threading.Event()
        f = FakeFetcher(dict(pages))
        orig = f.get
        f.get = lambda url: (stop.set(), orig(url))[1]  # после первой страницы — «стоп»
        res = pm.run(pos, pm.Settings(min_pause=0, max_pause=0), log=lambda m: None, fetcher=f, stop=stop)
        self.assertEqual(len(f.calls), 1)
        self.assertEqual(sum(r.status == "ok" for r in res), 1)


class _H(http.server.BaseHTTPRequestHandler):
    PAGES = {
        "/p1": (200, "text/html; charset=utf-8", prod("23 715", "018160")),
        "/p2": (200, "text/html; charset=windows-1251", "<html><head><meta charset='windows-1251'></head><body><h1>Полотенцесушитель 018184</h1>"
                                                          "<div class='price'>31 000 руб.</div></body></html>"),
        "/cap": (403, "text/html; charset=utf-8", "<title>Just a moment...</title><body>Checking your browser</body>"),
        "/gone": (404, "text/html; charset=utf-8", "<title>Страница не найдена</title>"),
    }

    def do_GET(self):
        code, ctype, body = self.PAGES.get(self.path, (500, "text/plain", "boom"))
        data = body.encode("cp1251" if "1251" in ctype else "utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(data)
        _H.seen.append(self.headers.get("User-Agent"))

    def log_message(self, *a):
        pass


_H.seen = []


class RealHTTP(unittest.TestCase):
    def test_requests_fetcher(self):
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_port}"
        try:
            P, L = pm.Position, pm.Link
            pos = [P("EC-3", "018160", 27900, [L(base.replace("127.0.0.1", "localhost") + "/p1"), L(base + "/cap"), L(base + "/gone"), L(base + "/err")]),
                   P("EC-4", "018184", 34100, [L(base.replace("127.0.0.1", "localhost") + "/p2")])]  # другой «сайт»
            res = pm.run(pos, pm.Settings(min_pause=0.01, max_pause=0.02), log=lambda m: None)
            by = {r.link.url.rsplit("/", 1)[1]: r for r in res}
            self.assertEqual(by["p1"].price, 23715)
            self.assertEqual(by["p2"].price, 31000, "cp1251 декодирован")
            # все ссылки на одном «сайте» 127.0.0.1: после капчи остальные пропускаются
            self.assertEqual(by["cap"].status, "blocked")
            later = [k for k in ("gone", "err") if by[k].status == "skipped"]
            self.assertTrue(all(by[k].error for k in later))
            self.assertTrue(all("PriceMonitor/" in (ua or "") for ua in _H.seen), "один честный User-Agent")
        finally:
            srv.shutdown()


class NotebookSync(unittest.TestCase):
    def test_notebook_embeds_current_module(self):
        import json
        here = os.path.dirname(os.path.abspath(__file__))
        nb = json.load(open(os.path.join(here, "price_monitor.ipynb"), encoding="utf-8"))
        src = open(os.path.join(here, "pricemon.py"), encoding="utf-8").read()
        cell = next(c for c in nb["cells"] if "".join(c["source"]).startswith("%%writefile pricemon.py"))
        self.assertEqual("".join(cell["source"]).split("\n", 1)[1].rstrip("\n"), src.rstrip("\n"),
                         "ноутбук устарел: запустите python price-monitor/colab/make_notebook.py")

    def test_notebook_calls_existing_api(self):
        import json
        import re
        here = os.path.dirname(os.path.abspath(__file__))
        nb = json.load(open(os.path.join(here, "price_monitor.ipynb"), encoding="utf-8"))
        code = "".join("".join(c["source"]) for c in nb["cells"]
                       if c["cell_type"] == "code" and not "".join(c["source"]).startswith("%%writefile"))
        names = set(re.findall(r"\bpm\.([A-Za-z_]\w*)", code))
        self.assertTrue(names)
        self.assertEqual([n for n in names if not hasattr(pm, n)], [])
        for c in nb["cells"]:  # python-синтаксис ячеек (без !shell и %%magic)
            src = "".join(c["source"])
            if c["cell_type"] == "code" and not src.startswith("%%"):
                body = "\n".join((l[:len(l) - len(l.lstrip())] + "pass") if l.lstrip().startswith("!") else l
                                 for l in src.splitlines())
                compile(body, "cell", "exec")


if __name__ == "__main__":
    unittest.main()
