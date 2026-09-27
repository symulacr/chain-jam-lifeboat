#!/usr/bin/env node
/**
 * `npm run build` — assemble dist/ with no bundler and no dependency.
 *
 * Copies:
 *   index.html          -> dist/index.html
 *   game/               -> dist/game/        (model.mjs — the single source of truth)
 *   src/                -> dist/src/         (app.js, styles.css, sdk/guest.mjs)
 *   public/*            -> dist/             (game.manifest.json, og-image.png, host configs)
 *
 * dist/ is therefore a static tree with the relative layout the page expects:
 *   dist/index.html  loads  ./src/styles.css, ./src/app.js, ./game/model.mjs, og-image.png
 *
 * Markdown inside the copied directories is skipped so dist/ stays a pure servable artefact
 * (the shipped surface carries no README, matching the verified flat candidate's dist/).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) copyTree(path.join(src, e), path.join(dst, e));
    return;
  }
  if (/\.md$/i.test(src)) return; // keep dist/ a pure servable tree
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

copyTree(path.join(root, 'index.html'), path.join(dist, 'index.html'));
copyTree(path.join(root, 'game'), path.join(dist, 'game'));
copyTree(path.join(root, 'src'), path.join(dist, 'src'));
for (const e of fs.readdirSync(path.join(root, 'public'))) {
  copyTree(path.join(root, 'public', e), path.join(dist, e));
}

const files = walk(dist);
let raw = 0;
let gz = 0;
let pageRaw = 0;
let pageGz = 0;
for (const f of files) {
  const buf = fs.readFileSync(f);
  const g = zlib.gzipSync(buf, { level: 9 }).length;
  raw += buf.length;
  gz += g;
  if (/\.(html|css|mjs|js)$/.test(f)) {
    pageRaw += buf.length;
    pageGz += g;
  }
}

console.log(`built dist/ — ${files.length} files`);
for (const f of files) {
  const rel = path.relative(dist, f);
  console.log(`  ${String(fs.readFileSync(f).length).padStart(7)} B  ${rel}`);
}
console.log(`\ndist total : ${raw.toLocaleString()} B raw / ${gz.toLocaleString()} B gzip`);
console.log(`dist page  : ${pageRaw.toLocaleString()} B raw / ${pageGz.toLocaleString()} B gzip (html+css+js+mjs)`);
