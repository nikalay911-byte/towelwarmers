"""Собирает price_monitor.ipynb из pricemon.py (модуль встраивается в ноутбук — он работает и без репозитория).
   python price-monitor/colab/make_notebook.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "nikalay911-byte/towelwarmers"
COLAB_URL = f"https://colab.research.google.com/github/{REPO}/blob/main/price-monitor/colab/price_monitor.ipynb"


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(True)}


def code(text, form=False):
    meta = {"cellView": "form"} if form else {}
    return {"cell_type": "code", "metadata": meta, "execution_count": None, "outputs": [], "source": text.strip("\n").splitlines(True)}


module_src = open(os.path.join(HERE, "pricemon.py"), encoding="utf-8").read()

cells = [
    md(f"""
# Монитор цен конкурентов — Google Colab

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)]({COLAB_URL})

Проверяет цены наших позиций у конкурентов **по одной странице за раз со случайной паузой** и считает отклонение
`((цена конкурента − наша цена) / наша цена) × 100`. Цена ниже нашей → **демпинг**. Отчёт:

| Цена товара | Разница в цене в % | Магазин демпинг | Ссылка на магазин конкурента |
|---|---|---|---|

**Как пользоваться:** `Среда выполнения → Выполнить все` (или Ctrl+F9). Потом поменяйте настройки в шаге 2 и источник позиций в шаге 3.

* Капчи, Cloudflare, 403/429 расширение **не обходит**: такой сайт пропускается до конца прогона.
* После ошибки 5xx страница один раз перепроверяется в конце очереди.
* Колонки списка позиций такие же, как в расширении: `Наименование · Артикул · Наша цена · Ссылка [· Якорь · CSS-селектор]`.
"""),
    md("## 1. Установка"),
    code("""
# requests и pandas в Colab уже есть
!pip -q install beautifulsoup4 lxml openpyxl
"""),
    code("%%writefile pricemon.py\n" + module_src),
    md("## 2. Настройки"),
    code("""
#@title Настройки проверки { display-mode: "form" }
MIN_PAUSE = 5  #@param {type:"number"}
MAX_PAUSE = 10  #@param {type:"number"}
#@markdown Один и тот же сайт — не чаще чем раз в N секунд (0 — только общая пауза):
DOMAIN_GAP = 0  #@param {type:"number"}
#@markdown Демпинг — если цена ниже нашей больше чем на N %:
DUMP_THRESHOLD = 0  #@param {type:"number"}
EXCLUDED = "comfysan.ru, comfysan-shop.ru, polotenhik.ru, sancomfgroup.ru, sancomf.ru"  #@param {type:"string"}
#@markdown Сайты, которые собирают страницу через JavaScript (откроются в headless Chromium; +1–2 мин на установку):
USE_BROWSER_FOR = ""  #@param {type:"string"}

import importlib, pricemon as pm
importlib.reload(pm)
settings = pm.Settings(min_pause=MIN_PAUSE, max_pause=MAX_PAUSE, domain_gap=DOMAIN_GAP,
                       dump_threshold_pct=DUMP_THRESHOLD, excluded_domains=EXCLUDED,
                       use_browser_for=USE_BROWSER_FOR).normalized()
print(settings)
""", form=True),
    md("## 3. Позиции и ссылки конкурентов"),
    code("""
#@title Откуда взять список { display-mode: "form" }
SOURCE = "пример (4 позиции Comfysan)"  #@param ["пример (4 позиции Comfysan)", "загрузить файл CSV/XLSX", "Google Таблица"]
#@markdown Для Google Таблицы — ссылка на неё (первый лист, колонки: Наименование, Артикул, Наша цена, Ссылка, [Якорь], [CSS-селектор]):
SHEET_URL = ""  #@param {type:"string"}

import copy, pandas as pd
if SOURCE.startswith("пример"):
    positions = copy.deepcopy(pm.SAMPLE_POSITIONS)
elif SOURCE.startswith("загрузить"):
    from google.colab import files
    up = files.upload()                       # CSV из расширения («Выгрузить позиции») или Excel
    name = next(iter(up))
    open(name, "wb").write(up[name])
    positions = pm.load_positions(name)
else:
    from google.colab import auth
    import gspread
    from google.auth import default
    auth.authenticate_user()
    gc = gspread.authorize(default()[0])
    positions = pm.positions_from_rows(gc.open_by_url(SHEET_URL).sheet1.get_all_values())

links = sum(len(p.links) for p in positions)
print(f"Позиций: {len(positions)}, ссылок: {links}")
pd.DataFrame([{"Товар": p.name, "Артикул": p.article, "Наша цена": p.our_price, "Ссылка": l.url, "Якорь": l.anchor}
              for p in positions for l in p.links])
""", form=True),
    code("""
#@title (необязательно) Chromium для JS-сайтов из USE_BROWSER_FOR { display-mode: "form" }
if settings.use_browser_for:
    !pip -q install playwright
    !playwright install --with-deps chromium > /dev/null
    print("Chromium установлен для:", ", ".join(settings.use_browser_for))
else:
    print("USE_BROWSER_FOR пуст — пропускаем.")
"""),
    md("## 4. Проверка\nЛог идёт по мере проверки. Остановить проверку — кнопка ■ слева от ячейки."),
    code("""
results = pm.run_auto(positions, settings)
"""),
    md("## 5. Отчёт"),
    code("""
from IPython.display import display, Markdown
from datetime import datetime
stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
display(pm.styled(results, settings))
csv_name, xlsx_name = f"конкуренты_{stamp}.csv", f"конкуренты_{stamp}.xlsx"
open(csv_name, "w", encoding="utf-8").write(pm.report_csv(results, settings))
pm.save_xlsx(results, xlsx_name, settings)
display(Markdown(f"Сохранено: `{csv_name}`, `{xlsx_name}` (папка слева 📁)."))
"""),
    code("""
#@title Скачать Excel на компьютер { display-mode: "form" }
from google.colab import files
files.download(xlsx_name)
""", form=True),
    md("## 6. (необязательно) Google Диск и Google Таблицы"),
    code("""
#@title Сохранить на Google Диск + накопительная история цен { display-mode: "form" }
DRIVE_FOLDER = "МониторЦен"  #@param {type:"string"}
from google.colab import drive
import os, shutil
drive.mount("/content/drive")
folder = f"/content/drive/MyDrive/{DRIVE_FOLDER}"
os.makedirs(folder, exist_ok=True)
shutil.copy(xlsx_name, folder)
hist_path = f"{folder}/история.csv"
hist = pd.DataFrame(pm.history_rows(results, settings))
hist.to_csv(hist_path, mode="a", header=not os.path.exists(hist_path), index=False, sep=";", encoding="utf-8-sig")
print("Отчёт:", f"{folder}/{xlsx_name}")
print("История:", hist_path, "— строк добавлено:", len(hist))
""", form=True),
    code("""
#@title Выгрузить отчёт в Google Таблицу { display-mode: "form" }
REPORT_SHEET_URL = ""  #@param {type:"string"}
from google.colab import auth
import gspread
from google.auth import default
auth.authenticate_user()
gc = gspread.authorize(default()[0])
sh = gc.open_by_url(REPORT_SHEET_URL)
df = pm.report_df(results, settings).astype(object).where(lambda d: d.notna(), "")
try:
    ws = sh.worksheet("Конкуренты")
    ws.clear()
except gspread.WorksheetNotFound:
    ws = sh.add_worksheet("Конкуренты", rows=len(df) + 10, cols=len(df.columns))
ws.update([list(df.columns)] + df.values.tolist())
try:
    hs = sh.worksheet("История")
except gspread.WorksheetNotFound:
    hs = sh.add_worksheet("История", rows=1000, cols=7)
    hs.append_row(["Проверено", "Артикул", "Магазин", "Цена", "Наша цена", "Разница в %", "Ссылка"])
hs.append_rows([list(r.values()) for r in pm.history_rows(results, settings)])
print("Готово:", REPORT_SHEET_URL)
""", form=True),
    md("## 7. (необязательно) Повторять по расписанию, пока вкладка открыта"),
    code("""
#@title Повторять каждые N часов { display-mode: "form" }
REPEAT_HOURS = 6  #@param {type:"number"}
ROUNDS = 4  #@param {type:"integer"}
#@markdown Бесплатный Colab отключает среду через ~90 мин бездействия и максимум через 12 ч — для ежедневной работы без присмотра см. README.
import time, os
for i in range(ROUNDS):
    print(f"\\n===== Круг {i + 1} из {ROUNDS} =====")
    results = pm.run_auto(positions, settings)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    pm.save_xlsx(results, f"конкуренты_{stamp}.xlsx", settings)
    if os.path.isdir("/content/drive/MyDrive"):
        folder = f"/content/drive/MyDrive/{DRIVE_FOLDER if 'DRIVE_FOLDER' in globals() else 'МониторЦен'}"
        os.makedirs(folder, exist_ok=True)
        pm.save_xlsx(results, f"{folder}/конкуренты_{stamp}.xlsx", settings)
        pd.DataFrame(pm.history_rows(results, settings)).to_csv(f"{folder}/история.csv", mode="a",
            header=not os.path.exists(f"{folder}/история.csv"), index=False, sep=";", encoding="utf-8-sig")
    dumps = [r for r in pm.report_rows(results, settings) if r["Магазин демпинг"].endswith("— Да")]
    print(f"Демпинг: {len(dumps)}")
    for r in dumps:
        print(f"  {r['Магазин демпинг']}: {r['Артикул']} {pm.fmt_money(r['Цена товара'])} ({pm.fmt_pct(r['Разница в цене в %'])})")
    if i < ROUNDS - 1:
        print(f"Следующий круг через {REPEAT_HOURS} ч")
        time.sleep(REPEAT_HOURS * 3600)
""", form=True),
]

nb = {
    "cells": cells,
    "metadata": {
        "colab": {"provenance": [], "toc_visible": True, "name": "price_monitor.ipynb"},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 0,
}
out = os.path.join(HERE, "price_monitor.ipynb")
with open(out, "w", encoding="utf-8") as f:
    json.dump(nb, f, ensure_ascii=False, indent=1)
    f.write("\n")
print("готово:", out)
