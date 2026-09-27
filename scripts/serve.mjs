#!/usr/bin/env node
/**
 * `npm run serve` — a dependency-free static server for the built dist/ on port 8901.
 *
 * Run `npm run build` first. `.mjs` is served as `text/javascript` (required for ES-module
 * imports); no other headers are added, and in particular no X-Frame-Options is set, so the
 * page stays embeddable.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE_DIR = path.join(root, 'dist');
const PORT = Number(process.env.PORT ?? 8901);

if (!fs.existsSync(SERVE_DIR)) {
  console.error('dist/ not found — run `npm run build` first');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('400 bad request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(SERVE_DIR, rel);
  if (!file.startsWith(SERVE_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('403 forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 ' + rel);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${path.relative(root, SERVE_DIR)}/ on http://127.0.0.1:${PORT}/`);
});
