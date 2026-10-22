/*
 * Собирает dist/ostatki-nika-41-<version>.zip — то, что можно отдать коллеге
 * для «загрузить распакованное» или залить в магазин (нужен будетManifest без полей-заглушек).
 *   npm run package
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const keep = [
  'manifest.json', 'background.js', 'README.md', 'LICENSE',
  'app', 'popup', 'options', 'vendor', 'icons', 'demo'
];
const out = path.join(root, 'dist');
const stage = path.join(out, 'stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

let files = 0, bytes = 0;
for (const item of keep) {
  const from = path.join(root, item);
  if (!fs.existsSync(from)) { console.warn('пропущено (нет в репозитории): ' + item); continue; }
  const st = fs.statSync(from);
  if (st.isDirectory()) fs.cpSync(from, path.join(stage, item), { recursive: true, filter: (s) => !/node_modules|\.map$/.test(s) });
  else fs.copyFileSync(from, path.join(stage, item));
}
for (const f of walk(stage)) { files++; bytes += fs.statSync(f).size; }

const zip = path.join(out, `ostatki-nika-41-${pkg.version}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: stage, stdio: 'inherit' });
fs.writeFileSync(path.join(out, 'MANIFEST-check.txt'), `files: ${files}\nsize: ${(bytes / 1024).toFixed(0)} KB\nzip: ${path.basename(zip)}\n`);
console.log(`dist/${path.basename(zip)} — файлов ${files}, несжатых ${(bytes / 1024 / 1024).toFixed(2)} МБ`);
console.log('Установка: chrome://extensions → режим разработчика → «Загрузить распакованное расширение» → папка dist/stage');

function walk(dir) {
  const outArr = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) outArr.push(...walk(p)); else outArr.push(p);
  }
  return outArr;
}
