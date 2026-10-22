/*
 * Копирует SheetJS из node_modules в vendor/ (в репозитории лежит готовый файл,
 * чтобы расширение работало без сборки). Обновлять осознанно: vendor/xlsx.full.min.js
 * должен оставаться без eval/new Function — на то есть тест.
 *   node tools/sync-vendor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
const dst = path.join(root, 'vendor', 'xlsx.full.min.js');

if (!fs.existsSync(src)) {
  console.error('Нет node_modules/xlsx — выполните npm install (или оставьте текущий vendor-файл).');
  process.exit(1);
}
const buf = fs.readFileSync(src);
const text = buf.toString('utf8');
const banned = [['new Function', /new\s+Function\s*\(/], ['eval(', /[^a-zA-Z$.]eval\s*\(/], ['importScripts', /importScripts\s*\(/]];
const hits = banned.filter(([, re]) => re.test(text));
if (hits.length) {
  console.error('В новой версии SheetJS найдено то, что блокирует CSP расширения: ' + hits.map(h => h[0]).join(', '));
  console.error('Оставьте старый vendor-файл или соберите сборку без этих мест.');
  process.exit(2);
}
const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'xlsx', 'package.json'), 'utf8')).version;
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, Buffer.concat([Buffer.from(`/* SheetJS ${version} (xlsx.full.min.js) — локальная копия, без eval/new Function. Обновление: npm run vendor */\n`, 'utf8'), buf]));
console.log(`vendor/xlsx.full.min.js ← xlsx@${version}, ${(buf.length / 1024) | 0} КБ, CSP-safe`);
