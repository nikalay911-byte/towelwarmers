/*
 * Собирает dist/price-monitor-<version>.zip — расширение «Монитор цен конкурентов»
 * для «Загрузить распакованное» (распаковать zip) или раздачи коллегам.
 *   npm run monitor:package
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const keep = ['manifest.json', 'background.js', 'README.md', 'lib', 'dashboard', 'popup', 'icons'];
const out = path.join(repo, 'dist');
const stage = path.join(out, 'price-monitor');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const item of keep) fs.cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
const zip = path.join(out, `price-monitor-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: stage, stdio: 'inherit' });
console.log(`dist/${path.basename(zip)} готов. Установка: chrome://extensions → режим разработчика → «Загрузить распакованное» → dist/price-monitor`);
