#!/usr/bin/env node

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ENV_FILES = [path.join(__dirname, '.env'), path.resolve(__dirname, '..', '..', 'QuickAuthSDKTest', 'sdk-e2e', '.env')];
const ENV_FILE = ENV_FILES.find((f) => fs.existsSync(f));
if (ENV_FILE) process.loadEnvFile(ENV_FILE);

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const PORT = Number(opt('port') || 5174);
const API_BASE = (opt('api') || process.env.QA_API_BASE_URL || 'https://api.quickauth.in').replace(/\/$/, '');
const CLIENT_ID = process.env.QA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QA_CLIENT_SECRET || '';
const PUBLISHABLE_KEY = process.env.QA_PUBLISHABLE_KEY || '';
const ROOT = path.resolve(__dirname, '..');

if (!PUBLISHABLE_KEY && !(CLIENT_ID && CLIENT_SECRET)) {
  console.error('Set QA_PUBLISHABLE_KEY and/or QA_CLIENT_ID + QA_CLIENT_SECRET — copy e2e/.env.example to e2e/.env and fill it in.');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.global.js'))) {
  console.error('dist/index.global.js not found — run `npm run build` first.');
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.map': 'application/json', '.json': 'application/json' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFile(res, rel) {
  const file = path.resolve(ROOT, rel);
  const allowed = [path.join(ROOT, 'dist') + path.sep, path.join(ROOT, 'e2e', 'index.html')];
  if (!allowed.some((a) => file === a || file.startsWith(a)) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

let mints = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const t0 = Date.now();
  const done = (label) => console.log(`${new Date().toISOString().slice(11, 19)}  ${req.method} ${url.pathname}${label ? `  ${label}` : ''}  ${Date.now() - t0}ms`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, 'e2e/index.html');
    if (url.pathname.startsWith('/dist/')) return serveFile(res, url.pathname.slice(1));

    if (url.pathname === '/api/config') {
      // A publishable key is public by design; the client secret never leaves this server.
      return send(res, 200, {
        apiBase: API_BASE,
        defaultPhone: process.env.QA_TEST_PHONE || '',
        publishableKey: PUBLISHABLE_KEY,
        hasClientSecret: !!(CLIENT_ID && CLIENT_SECRET),
      });
    }

    if (url.pathname === '/api/quickauth-token' && req.method === 'POST') {
      const r = await fetch(`${API_BASE}/v1/sdk/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, 'X-Client-Secret': CLIENT_SECRET },
        body: '{}',
      });
      const body = await r.json().catch(() => ({}));
      mints++;
      done(`mint #${mints} → ${r.status}`);
      return send(res, r.status, body);
    }

    if (url.pathname === '/api/auth-status') {
      const r = await fetch(`${API_BASE}/v1/auth/status?requestId=${encodeURIComponent(url.searchParams.get('requestId') || '')}`, {
        headers: { 'X-Client-Id': CLIENT_ID, 'X-Client-Secret': CLIENT_SECRET, Accept: 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      done(`→ ${r.status}`);
      return send(res, r.status, body);
    }

    if (url.pathname.startsWith('/proxy/')) {
      const target = API_BASE + url.pathname.slice('/proxy'.length) + url.search;
      const headers = {};
      for (const h of ['authorization', 'x-quickauth-key', 'content-type', 'idempotency-key', 'accept', 'origin']) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const r = await fetch(target, { method: req.method, headers, body });
      const buf = Buffer.from(await r.arrayBuffer());
      done(`→ ${r.status}`);
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
      return res.end(buf);
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    done(`ERROR ${err.message}`);
    send(res, 502, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nQuickAuth Web SDK — browser E2E harness`);
  console.log(`  open     http://localhost:${PORT}`);
  console.log(`  API      ${API_BASE}`);
  console.log(`  auth     ${[PUBLISHABLE_KEY && 'publishableKey', CLIENT_ID && CLIENT_SECRET && 'session token (backend mint)'].filter(Boolean).join(' + ')}`);
  console.log(`  env      ${ENV_FILE ? path.relative(process.cwd(), ENV_FILE) : 'shell only'}`);
  console.log(`  phone    chrome://inspect → Port forwarding → ${PORT} → localhost:${PORT}\n`);
});
