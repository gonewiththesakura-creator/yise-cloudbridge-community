import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', 'dist', '.git', 'bin', 'obj', 'artifacts']);
let checked = 0;
for (const path of files(root)) {
  if (/\.(mjs|js)$/.test(path)) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `Syntax check failed: ${path}`);
    checked++;
  }
  if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'));
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
for (const [name, version] of Object.entries(manifest.dependencies)) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Direct dependency is not pinned: ${name}`);
  if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Lock mismatch: ${name}`);
}
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (path && (!pkg.resolved?.startsWith('https://registry.npmjs.org/') || !pkg.integrity)) {
    throw new Error(`Dependency must have official registry source and integrity: ${path}`);
  }
}
console.log(`Syntax checked ${checked} JavaScript modules; dependency versions, registry sources, integrity fields and JSON validated.`);
function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}
