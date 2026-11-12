// Copy the publishable files into ../release/boxday (for a GitHub web upload or `git init`).
// Leaves out node_modules, .env, runtime data and logs. Usage: node scripts/make-release.mjs
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const OUT = path.resolve(ROOT, '..', 'release', 'boxday');
const MARK = path.join(OUT, '..', '.boxday-release-made'); // outside the upload folder
const INCLUDE = ['.env.example', '.gitignore', 'ARCHITECTURE.md', 'LICENSE', 'README.md', 'package.json', 'package-lock.json', 'server.js', 'data/farm.json', 'public', 'scripts', 'src', 'test'];

// Only ever clear a folder this script created.
if (existsSync(OUT)) {
  if (!existsSync(MARK)) throw new Error(`${OUT} exists but was not created by this script; not touching it.`);
  rmSync(OUT, { recursive: true });
}
for (const rel of INCLUDE) cpSync(path.join(ROOT, rel), path.join(OUT, rel), { recursive: true });
writeFileSync(MARK, 'Created by scripts/make-release.mjs. Not part of the repo.\n');

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p); else files.push(path.relative(OUT, p));
  }
})(OUT);
console.log(`${files.length} files in ${OUT}`);
for (const f of files) console.log('  ' + f.replaceAll('\\', '/'));
