// Tiny backend for the repro of https://issues.chromium.org/issues/455600248
// No dependencies: `node server.mjs` (Node 18+).
//
//   GET  /                  -> public/index.html (framework-free repro page)
//   POST /api/b2b/v2/stock  -> JSON, sent the way Spring Boot + Spring Security
//   GET  /api/b2b/v2/stock     send it: Spring Security's default headers
//                              (incl. Cache-Control: no-store), chunked body.
//
// Query parameters (for experiments):
//   ?nostore=0    send "Cache-Control: no-cache, max-age=0, must-revalidate" (no no-store)
//   ?chunks=32    write the body in N pieces ...
//   ?gap=1        ... with this many ms between them (Tomcat flushing its buffer)
//   ?items=50     number of items in the JSON
//   ?length=1     send Content-Length instead of Transfer-Encoding: chunked

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stockPayload(items) {
  return {
    items: Array.from({ length: items }, (_, i) => ({
      sku: `SKU-${100000 + i}`,
      gtin: `80192273${String(74674 + i).padStart(5, '0')}`,
      warehouse: ['MUC', 'HAM', 'BER'][i % 3],
      available: (i * 7) % 23,
      eta: '2025-10-28',
    })),
  };
}

// Response headers from the original report (Spring Boot + Spring Security defaults).
const SPRING_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '0',
  'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'X-Frame-Options': 'DENY',
};

async function stock(req, res, params) {
  for await (const _ of req) { /* drain the request body */ }

  const body = JSON.stringify(stockPayload(Number(params.get('items') ?? 50)));
  const chunks = Math.max(1, Number(params.get('chunks') ?? 32));
  const gap = Number(params.get('gap') ?? 1);

  const headers = { ...SPRING_HEADERS };
  if (params.get('nostore') === '0') headers['Cache-Control'] = 'no-cache, max-age=0, must-revalidate';
  if (params.get('length') === '1') headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(200, headers);

  const size = Math.ceil(body.length / chunks);
  for (let i = 0; i < chunks; i++) {
    if (i > 0 && gap) await sleep(gap);
    res.write(body.slice(i * size, (i + 1) * size));
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/b2b/v2/stock') {
    await stock(req, res, url.searchParams);
    return;
  }

  // Static files from ./public
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Repro server: http://localhost:${PORT}`);
});
