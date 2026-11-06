// Automated check for https://issues.chromium.org/issues/455600248
//
// Launches Chrome, enables the DevTools Network domain (like an open Network
// panel), triggers requests on the repro page, and then asks for each response
// body with Network.getResponseBody, as the Response/Preview tab does.
//
// No dependencies (uses Node's built-in WebSocket, Node 22+).
//
//   node verify.mjs                                   # plain page, all variants
//   node verify.mjs --runs 50 --variants fetch-abort
//   node verify.mjs --url http://localhost:4200/ --trigger "document.querySelector('#load').click()"
//   CHROME=/path/to/chrome node verify.mjs --headful

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080/' },
    runs: { type: 'string', default: '20' },
    variants: { type: 'string', default: 'fetch-reader,fetch-reader-cacheable,fetch-json,xhr' },
    query: { type: 'string', default: '' },
    trigger: { type: 'string' },
    label: { type: 'string', default: 'custom trigger' },
    headful: { type: 'boolean', default: false },
    chrome: { type: 'string', default: process.env.CHROME ?? defaultChrome() },
    verbose: { type: 'boolean', default: false },
  },
});

function defaultChrome() {
  switch (process.platform) {
    case 'darwin': return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32': return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    default: return 'google-chrome';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Chrome + CDP
async function launchChrome() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'crbug-455600248-'));
  const proc = spawn(args.chrome, [
    ...(args.headful ? [] : ['--headless=new']),
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    port = await readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').then((s) => s.split('\n')[0]).catch(() => undefined);
  }
  if (!port) throw new Error(`Chrome did not start: ${args.chrome}`);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((t) => t.type === 'page');
  return {
    version: version.Browser,
    wsUrl: page.webSocketDebuggerUrl,
    async close() {
      proc.kill();
      await sleep(300);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res) => pending.set(id, { resolve: res }));
      },
      on(fn) { listeners.add(fn); },
      close() { ws.close(); },
    }));
  });
}

// ---------------------------------------------------------------- main
const chrome = await launchChrome();
const cdp = await connect(chrome.wsUrl);

// Track every /api/ request the way the DevTools Network panel sees it.
const requests = new Map(); // requestId -> { url, status, outcome }
cdp.on(({ method, params }) => {
  if (method === 'Network.requestWillBeSent' && params.request.url.includes('/api/')) {
    requests.set(params.requestId, { url: params.request.url, type: params.type, outcome: 'pending' });
  }
  const r = requests.get(params?.requestId);
  if (!r) return;
  if (method === 'Network.responseReceived') r.status = params.response.status;
  if (method === 'Network.loadingFinished') r.outcome = 'loadingFinished';
  if (method === 'Network.loadingFailed') r.outcome = `loadingFailed(${params.canceled ? 'canceled' : params.errorText})`;
});

await cdp.send('Network.enable', { maxPostDataSize: 65536 });
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: args.url });
await sleep(1500);

const jobs = args.trigger
  ? [{ label: args.label, expr: args.trigger }]
  : args.variants.split(',').map((v) => ({ label: v, expr: `runVariant(${JSON.stringify(v)}, ${JSON.stringify(args.query)})` }));

console.log(`Browser: ${chrome.version}`);
console.log(`Page:    ${args.url}${args.query ? ` (query: ${args.query})` : ''}`);
console.log(`Runs:    ${args.runs} per variant\n`);

const results = [];
for (const job of jobs) {
  const summary = { variant: job.label, runs: 0, bodyOk: 0, bodyMissing: 0, outcomes: {}, errors: {} };
  for (let i = 0; i < Number(args.runs); i++) {
    const before = new Set(requests.keys());
    const evalResult = await cdp.send('Runtime.evaluate', { expression: job.expr, awaitPromise: true, returnByValue: true });
    if (evalResult.result?.exceptionDetails) {
      console.error('Page error:', evalResult.result.exceptionDetails.exception?.description ?? evalResult.result.exceptionDetails.text);
    }
    // Wait until the new request(s) are finished/failed from DevTools' point of view.
    let fresh = [];
    for (let t = 0; t < 200; t++) {
      fresh = [...requests.keys()].filter((id) => !before.has(id));
      if (fresh.length && fresh.every((id) => requests.get(id).outcome !== 'pending')) break;
      await sleep(25);
    }
    await sleep(50);
    for (const id of fresh) {
      const r = requests.get(id);
      const body = await cdp.send('Network.getResponseBody', { requestId: id });
      summary.runs++;
      summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] ?? 0) + 1;
      if (body.result && body.result.body.length > 0) {
        summary.bodyOk++;
      } else {
        summary.bodyMissing++;
        const msg = body.error?.message ?? 'empty body';
        summary.errors[msg] = (summary.errors[msg] ?? 0) + 1;
      }
      if (args.verbose) console.log(`  ${job.label} #${i + 1} ${r.type} status=${r.status} ${r.outcome} -> ${body.error ? `ERROR ${body.error.message}` : `${body.result.body.length} bytes`}`);
    }
  }
  results.push(summary);
}

const w = Math.max(7, ...results.map((s) => s.variant.length));
console.log('variant'.padEnd(w), 'requests'.padStart(8), 'body ok'.padStart(8), 'missing'.padStart(8), '  DevTools events / getResponseBody errors');
for (const s of results) {
  const detail = [
    ...Object.entries(s.outcomes).map(([k, v]) => `${k} x${v}`),
    ...Object.entries(s.errors).map(([k, v]) => `"${k}" x${v}`),
  ].join(', ');
  console.log(s.variant.padEnd(w), String(s.runs).padStart(8), String(s.bodyOk).padStart(8), String(s.bodyMissing).padStart(8), ' ', detail);
}

cdp.close();
await chrome.close();
process.exit(results.some((s) => s.bodyMissing > 0) ? 1 : 0);
