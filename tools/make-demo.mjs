/*
 * Генератор демо-прайса: demo/demo-data.js (для кнопки «демо» в приложении)
 * и настоящие файлы demo/price-demo.xls / .xlsx, чтобы проверить импорт.
 *   node tools/make-demo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// детерминированный ПСЧ, чтобы демо-файл не менялся без нужды
let seed = 410921;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(a) { return a[Math.floor(rnd() * a.length) % a.length]; }
function ri(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }

const MODELS = [
  ['Ника', [480, 320], 1], ['Ника L', [600, 320], 1], ['Ника XL', [800, 400], 1], ['Ника Mini', [300, 300], 1],
  ['Ника П-образная', [500, 400], 1], ['Ника Полка', [600, 500], 1], ['Ника Фокс', [1000, 400], 1],
  ['Ника Телескоп', [550, 300], 1], ['Ника Ребра', [700, 350], 1], ['Ника Мегаклассик', [1200, 500], 1],
  ['Ника Ампир', [660, 400], 2], ['Ника Каскад', [800, 500], 2], ['Ника Лестница', [1500, 500], 2],
  ['Ника Змейка', [1000, 320], 1], ['Ника Волна', [600, 300], 1], ['Ника Ромб', [700, 400], 2],
  ['Ника Терра', [900, 450], 2], ['Ника Аксиома', [1200, 600], 3], ['Ника Форвард', [660, 320], 2],
  ['Ника Галант', [800, 400], 2], ['Ника Стриж', [500, 300], 1], ['Ника Гранд', [1600, 600], 3]
];
const COLORS = ['белый', 'хром', 'чёрный', 'серебристый металлик', 'графит', 'бежевый', 'золото матовое', 'иней', 'бордо', 'серый шёлк'];
const HIDDEN = ['молочный', 'венге', 'под золото', 'медь', 'антрацит', 'нерж. полир.'];
const SIZES = ['480×320', '500×300', '600×320', '600×500', '700×400', '800×400', '800×500', '1000×400', '1200×500', '1500×500'];
const TYPE = ['водяной', 'электрический', 'комбинированный'];

function qtyText(n) {
  if (n === 0) return rnd() < 0.35 ? 'нет' : 0;
  if (n >= 1000 && rnd() < 0.3) return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return n;
}

function buildAoa() {
  const aoa = [];
  aoa.push(['ООО «Ника 41» — прайс-лист, остатки на складе']);
  aoa.push(['Дата выгрузки: ' + new Date().toISOString().slice(0, 10) + '   (время местное)']);
  aoa.push([]);
  aoa.push(['Номенклатура', 'Характеристика (цвет)', 'Остаток']);
  const lines = [];
  for (let i = 0; i < MODELS.length; i++) {
    const [m, dims, sec] = MODELS[i];
    for (let k = 0; k < ri(5, 14); k++) {
      const color = rnd() < 0.72 ? COLORS[k % COLORS.length] : pick(HIDDEN);
      const size = pick(SIZES);
      const n = ri(0, 14) === 0 ? 0 : ri(1, 4) < 2 ? ri(1, 6) : (rnd() < 0.12 ? ri(1000, 4200) : ri(6, 380));
      lines.push([
        `Полотенцесушитель ${m} ${size} ${pick(TYPE)}, ${sec} секция`,
        color,
        qtyText(n)
      ]);
    }
  }
  // «итого» внизу — реальная боль прайсов, приложение обязано это переварить
  lines.push(['ИТОГО', '', lines.length]);
  return aoa.concat(lines);
}

function buildSecondSheet() {
  const aoa = [['Номенклатура', 'Характеристика (цвет)', 'Остаток']];
  for (let i = 0; i < 60; i++) {
    aoa.push([`Снято с производства: Ника ${pick(SIZES)}`, pick(COLORS.concat(HIDDEN)), ri(0, 2)]);
  }
  return aoa;
}

const aoa = buildAoa();
const aoa2 = buildSecondSheet();

/* demo-data.js — встроенный демо-набор для страницы (работает и с file://, и в расширении) */
const jsOut = '/* автогенерация: tools/make-demo.mjs — демо-прайс «Ника 41» */\n'
  + '(function (r) { r.OST_DEMO = ' + JSON.stringify(aoa) + '; })(typeof globalThis !== "undefined" ? globalThis : this);\n';
fs.writeFileSync(path.join(root, 'demo', 'demo-data.js'), jsOut);

/* настоящие файлы для проверки импорта */
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Прайс Ника');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa2), 'Архив');
XLSX.writeFile(wb, path.join(root, 'demo', 'price-demo.xlsx'));
try {
  XLSX.writeFile(wb, path.join(root, 'demo', 'price-demo.xls'), { bookType: 'biff8' });
} catch (e) { console.warn('biff8 write skipped:', e.message); }

/* CSV-версия — для проверки импорта CSV */
const csv = aoa.map(r => r.map(c => {
  const s = c === null || c === undefined ? '' : String(c);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(';')).join('\r\n');
fs.writeFileSync(path.join(root, 'demo', 'price-demo.csv'), '\ufeff' + csv);

console.log('demo: строк с данными =', aoa.length - 4, '| листов = 2');
