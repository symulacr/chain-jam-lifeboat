#!/usr/bin/env node
/**
 * `npm run check` — `node --check` on every .js/.mjs in the project.
 *
 * node_modules and dist/ are skipped (dist/ is a copy of already-checked sources).
 * Exits non-zero if any file fails to parse.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(root).sort();
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  ok   ${path.relative(root, f)}`);
  } catch (err) {
    bad++;
    console.log(`  FAIL ${path.relative(root, f)}: ${String(err.stderr).split('\n')[0]}`);
  }
}
console.log(`\n${files.length - bad}/${files.length} JS files parse`);
process.exit(bad ? 1 : 0);
