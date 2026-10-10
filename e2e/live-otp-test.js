#!/usr/bin/env node

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const readline = require('readline/promises');

const ENV_FILES = [path.join(__dirname, '.env'), path.resolve(__dirname, '..', '..', 'QuickAuthSDKTest', 'sdk-e2e', '.env')];
const ENV_FILE = ENV_FILES.find((f) => fs.existsSync(f));
if (ENV_FILE) {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('Loading .env needs Node 20.12+ — or export the QA_* variables yourself.');
    process.exit(1);
  }
  process.loadEnvFile(ENV_FILE);
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

const ARGS = {
  phone: opt('phone') || process.env.QA_TEST_PHONE || undefined,
  channel: opt('channel') || 'auto',
  api: opt('api') || process.env.QA_API_BASE_URL || undefined,
  unsafe: flag('unsafe'),
  token: flag('token'),
  offline: flag('offline'),
  fresh: flag('fresh'),
  verbose: flag('verbose'),
  yes: flag('yes'),
};

const API_BASE = (ARGS.api || 'https://api.quickauth.in').replace(/\/$/, '');
const CLIENT_ID = process.env.QA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QA_CLIENT_SECRET || '';
const PUBLISHABLE_KEY = process.env.QA_PUBLISHABLE_KEY || '';
// Publishable key is the recommended mode and the default when QA_PUBLISHABLE_KEY is set;
// --token uses onTokenExpiry with a backend mint, --unsafe the in-client secret.
const MODE = ARGS.unsafe ? 'unsafe' : ARGS.token || !PUBLISHABLE_KEY ? 'token' : 'publishableKey';

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const results = [];

function section(title) {
  console.log(`\n${c.bold(c.cyan(`━━ ${title} `.padEnd(72, '━')))}`);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, status: 'PASS', note });
    console.log(`  ${c.green('✔')} ${name}${note ? c.dim(`  — ${note}`) : ''} ${c.dim(`(${Date.now() - t0}ms)`)}`);
    return true;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    results.push({ name, status: 'FAIL', note: msg });
    console.log(`  ${c.red('✘')} ${name}\n      ${c.red(msg)}`);
    if (err && err.body !== undefined) console.log(c.dim(`      body: ${JSON.stringify(err.body)}`));
    return false;
  }
}

function skip(name, why) {
  results.push({ name, status: 'SKIP', note: why });
  console.log(`  ${c.yellow('○')} ${name} ${c.dim(`— skipped: ${why}`)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function expectReject(promiseOrFn, matcher) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    if (matcher && !matcher.test(err.message)) {
      throw new Error(`rejected with unexpected message: ${err.message}`);
    }
    return err.message;
  }
  throw new Error('expected a rejection, but it resolved');
}

function expectThrowSync(fn, matcher) {
  try {
    fn();
  } catch (err) {
    if (matcher && !matcher.test(err.message)) {
      throw new Error(`threw unexpected message: ${err.message}`);
    }
    return err.message;
  }
  throw new Error('expected a throw, but it returned');
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function fakeJwt(secs) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + secs })}.sig`;
}

function stubFetch(respond) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = (await respond(String(url), init, calls.length)) || {};
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const httpLog = [];
const realFetch = globalThis.fetch;
if (typeof realFetch !== 'function') {
  console.error('This script needs Node 18+ (global fetch).');
  process.exit(1);
}

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /token|secret/i.test(k) && typeof v === 'string' ? `${v.slice(0, 6)}…(${v.length})` : redact(v);
  }
  return out;
}

async function tappedFetch(url, init = {}) {
  const t0 = Date.now();
  const u = new URL(String(url));
  const entry = { method: init.method || 'GET', path: u.pathname + u.search, status: null, ms: 0 };
  if (init.body) {
    try {
      entry.request = JSON.parse(init.body);
    } catch {
      entry.request = init.body;
    }
  }
  httpLog.push(entry);
  try {
    const res = await realFetch(url, init);
    entry.status = res.status;
    entry.ms = Date.now() - t0;
    const text = await res.clone().text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text */
    }
    entry.body = body;
    const tone = res.ok ? c.green : c.red;
    console.log(c.dim(`      → ${entry.method} ${entry.path}  `) + tone(String(res.status)) + c.dim(` ${entry.ms}ms`));
    if (ARGS.verbose && entry.request) console.log(c.dim(`        sent ${JSON.stringify(redact(entry.request))}`));
    if (ARGS.verbose || !res.ok) console.log(c.dim(`        ${JSON.stringify(redact(body))}`));
    return res;
  } catch (err) {
    entry.ms = Date.now() - t0;
    entry.error = err.message;
    console.log(c.dim(`      → ${entry.method} ${entry.path}  `) + c.red(`NETWORK ERROR ${err.message}`));
    throw err;
  }
}

function lastServerError() {
  const last = [...httpLog].reverse().find((h) => h.status && h.status >= 400);
  const b = last && last.body;
  return b && typeof b === 'object' && (b.errorCode || b.message) ? ` — server: ${b.errorCode ?? ''} ${b.message ?? ''}` : '';
}

const STORE_FILE = path.join(__dirname, '.local-storage.json');
const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const writeStore = (obj) => fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2));
const localStorageShim = {
  get length() {
    return Object.keys(readStore()).length;
  },
  key: (i) => Object.keys(readStore())[i] ?? null,
  getItem: (k) => (k in readStore() ? readStore()[k] : null),
  setItem: (k, v) => writeStore({ ...readStore(), [k]: String(v) }),
  removeItem: (k) => {
    const s = readStore();
    delete s[k];
    writeStore(s);
  },
  clear: () => writeStore({}),
};

let locationHref = 'https://shop.example.com/landing';
const locationShim = {
  get href() {
    return locationHref;
  },
  set href(v) {
    locationHref = String(v);
  },
  get host() {
    return new URL(locationHref).host;
  },
};
globalThis.window = { localStorage: localStorageShim, location: locationShim };

const SDK_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(SDK_ROOT, 'dist', 'index.cjs');
if (!fs.existsSync(DIST)) {
  console.error(c.red('quickauth-sdk-web/dist not found — run `npm run build` first.'));
  process.exit(1);
}
const PKG_VERSION = require(path.join(SDK_ROOT, 'package.json')).version;
const { QuickAuth, QuickAuthError } = require(DIST);
const DEVICE_TOKEN_KEY = 'qa_device_token';

const events = [];
const eventBus = new EventEmitter();
function onAuthEvent(ev) {
  events.push({ at: Date.now(), ev });
  const tone = ev.type === 'VERIFIED' ? c.green : ev.type === 'ERROR' || ev.type === 'OTP_FAILED' ? c.red : c.cyan;
  console.log(`      ${tone('⚡ event')} ${JSON.stringify(ev)}`);
  eventBus.emit('event', ev);
}

function waitForEvent(types, { from = 0, timeoutMs = 30_000 } = {}) {
  const already = events.slice(from).find((e) => types.includes(e.ev.type));
  if (already) return Promise.resolve(already.ev);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventBus.off('event', handler);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${types.join(' | ')}`));
    }, timeoutMs);
    function handler(ev) {
      if (!types.includes(ev.type)) return;
      clearTimeout(timer);
      eventBus.off('event', handler);
      resolve(ev);
    }
    eventBus.on('event', handler);
  });
}

async function callAndWait(fn, types) {
  const from = events.length;
  const wait = waitForEvent(types, { from });
  try {
    await fn();
  } catch (err) {
    await tick();
    if (!events.slice(from).some((e) => types.includes(e.ev.type))) throw err;
  }
  return wait;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false;
rl.on('close', () => (inputClosed = true));
const ask = async (q) => {
  if (inputClosed) throw new Error('input closed (Ctrl-D / EOF) — aborting');
  return (await rl.question(`  ${c.bold('?')} ${q}`)).trim();
};
async function confirm(q, def = false) {
  if (ARGS.yes) {
    console.log(`  ${c.bold('?')} ${q} ${c.dim('(--yes)')}`);
    return true;
  }
  const a = (await ask(`${q} ${c.dim(def ? '[Y/n]' : '[y/N]')} `)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

const E164 = /^\+[1-9]\d{6,14}$/;

async function offlineChecks() {
  section('Phase 1 · Offline API checks (built bundle, stubbed fetch)');

  const savedStore = readStore();
  writeStore({});

  await step('isInitialized is false before init()', () => {
    assert(QuickAuth.isInitialized === false, 'isInitialized should be false');
    assert(QuickAuth.isConfigured() === false, 'deprecated isConfigured() should be false');
  });

  await step('config getter throws before init()', () => expectThrowSync(() => QuickAuth.config, /not initialised/));

  await step('auth.initiate before init() rejects', () =>
    expectReject(() => QuickAuth.auth.initiate({ phone: '+919999999999' }), /not initialised/)
  );
  QuickAuth.auth.reset();

  await step('init() with no auth mode throws', () => expectThrowSync(() => QuickAuth.init({}), /requires one of/));

  await step('init() with two auth modes throws', () =>
    expectThrowSync(
      () => QuickAuth.init({ onTokenExpiry: async () => 'tok', unsafe: { directClientId: 'qc_x', directClientSecret: 'y' }, silent: true }),
      /only one auth mode/
    )
  );

  await step('init() with unsafe credentials prints the UNSAFE warning', () => {
    const warn = console.warn;
    let warned = '';
    console.warn = (m) => (warned = String(m));
    try {
      QuickAuth.init({ unsafe: { directClientId: 'qc_x', directClientSecret: 'y' }, fetch: stubFetch(() => ({})) });
    } finally {
      console.warn = warn;
    }
    assert(/UNSAFE/.test(warned), 'console.warn mentions UNSAFE');
  });

  await step('init() defaults + trailing slash stripped from apiBaseUrl', () => {
    QuickAuth.init({ initialToken: fakeJwt(600), apiBaseUrl: 'https://api.example.test/', fetch: stubFetch(() => ({})) });
    const cfg = QuickAuth.config;
    assert(QuickAuth.isInitialized === true, 'isInitialized true');
    assert(cfg.apiBaseUrl === 'https://api.example.test', `apiBaseUrl (got ${cfg.apiBaseUrl})`);
    assert(cfg.maxRetries === 3 && cfg.storagePrefix === 'qa_', 'default maxRetries=3, storagePrefix=qa_');
    return `maxRetries=${cfg.maxRetries} prefix=${cfg.storagePrefix}`;
  });

  await step('QuickAuth.version matches package.json (dist is not stale)', () => {
    assert(QuickAuth.version === PKG_VERSION, `version ${QuickAuth.version} vs package.json ${PKG_VERSION}`);
    return `web@${QuickAuth.version}`;
  });

  await step('QuickAuthError is exported', () => {
    const e = new QuickAuthError('x', 418, { a: 1 });
    assert(e instanceof Error && e.name === 'QuickAuthError' && e.status === 418, 'shape');
  });

  await step('tokenManager: fresh initialToken is used without calling onTokenExpiry', async () => {
    let calls = 0;
    const initial = fakeJwt(600);
    QuickAuth.init({ initialToken: initial, onTokenExpiry: async () => (calls++, fakeJwt(600)), fetch: stubFetch(() => ({})) });
    assert((await QuickAuth.tokenManager.getToken()) === initial, 'returns initialToken');
    assert(calls === 0, 'onTokenExpiry not called');
  });

  await step('tokenManager: 20 concurrent getToken() → one onTokenExpiry call (single-flight)', async () => {
    let calls = 0;
    QuickAuth.init({
      onTokenExpiry: async () => {
        calls++;
        await tick();
        return fakeJwt(600);
      },
      fetch: stubFetch(() => ({})),
    });
    const toks = await Promise.all(Array.from({ length: 20 }, () => QuickAuth.tokenManager.getToken()));
    assert(calls === 1, `onTokenExpiry calls = ${calls}`);
    assert(new Set(toks).size === 1, 'all callers got the same token');
    QuickAuth.tokenManager.invalidate();
    await QuickAuth.tokenManager.getToken();
    assert(calls === 2, 'invalidate() forces a refresh');
  });

  await step('tokenManager: token inside the 30s refresh buffer is refreshed', async () => {
    let calls = 0;
    QuickAuth.init({ initialToken: fakeJwt(10), onTokenExpiry: async () => (calls++, fakeJwt(600)), fetch: stubFetch(() => ({})) });
    await QuickAuth.tokenManager.getToken();
    assert(calls === 1, 'near-expiry initialToken triggered onTokenExpiry');
  });

  await step('requests carry Bearer and Idempotency-Key, and no X-QA-SDK (CORS)', async () => {
    const tok = fakeJwt(600);
    const f = stubFetch(() => ({ body: { state: 'OTP_SENT', sessionId: 's1', expiresIn: 300 } }));
    QuickAuth.init({ initialToken: tok, fetch: f });
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    const h = f.calls[0].init.headers;
    assert(f.calls[0].url === 'https://api.quickauth.in/v1/sdk/auth/initiate', `url (got ${f.calls[0].url})`);
    assert(h.Authorization === `Bearer ${tok}`, 'Bearer token');
    assert(typeof h['Idempotency-Key'] === 'string' && h['Idempotency-Key'].length >= 16, 'Idempotency-Key');
    assert(!('X-QA-SDK' in h), 'X-QA-SDK must not be sent — the API CORS policy rejects it');
    QuickAuth.auth.reset();
    return `headers: ${Object.keys(h).join(', ')}`;
  });

  await step('publishableKey mode: X-QuickAuth-Key, no Authorization, no token mint', async () => {
    const f = stubFetch(() => ({ body: { state: 'OTP_SENT', sessionId: 's1', expiresIn: 300 } }));
    QuickAuth.init({ publishableKey: 'pk_test_offline', fetch: f });
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    const h = f.calls[0].init.headers;
    assert(f.calls.length === 1, `1 HTTP call (got ${f.calls.length})`);
    assert(h['X-QuickAuth-Key'] === 'pk_test_offline', `X-QuickAuth-Key (got ${h['X-QuickAuth-Key']})`);
    assert(!('Authorization' in h), 'no Authorization header');
    assert(!('X-QA-SDK' in h), 'no X-QA-SDK header');
    await expectReject(() => QuickAuth.tokenManager.getToken(), /publishableKey mode/);
    QuickAuth.auth.reset();
  });

  await step('publishableKey mode: HTTP 401 is not retried (no token to refresh)', async () => {
    const f = stubFetch(() => ({ status: 401, body: { errorCode: 'INVALID_CLIENT_CREDENTIALS', message: 'Invalid publishable key' } }));
    QuickAuth.init({ publishableKey: 'pk_test_bad', fetch: f, maxRetries: 3 });
    const err = await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch((e) => e);
    assert(err instanceof QuickAuthError && err.status === 401 && err.code === 'CLIENT_ERROR', `CLIENT_ERROR 401 (got ${err && err.code} ${err && err.status})`);
    assert(f.calls.length === 1, `1 HTTP call (got ${f.calls.length})`);
    QuickAuth.auth.reset();
  });

  await step('init() rejects publishableKey combined with another auth mode', () =>
    expectThrowSync(() => QuickAuth.init({ publishableKey: 'pk_test_x', onTokenExpiry: async () => 't' }), /only one auth mode/)
  );

  await step('HTTP 401 → token invalidated, refreshed once, request retried', async () => {
    let mints = 0;
    const f = stubFetch((_u, _i, n) => (n === 1 ? { status: 401, body: {} } : { body: { state: 'OTP_SENT', sessionId: 's', expiresIn: 60 } }));
    QuickAuth.init({ onTokenExpiry: async () => (mints++, fakeJwt(600)), fetch: f, maxRetries: 0 });
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    assert(f.calls.length === 2, `2 HTTP calls (got ${f.calls.length})`);
    assert(mints === 2, `2 token mints (got ${mints})`);
    QuickAuth.auth.reset();
  });

  await step('HTTP 5xx is retried with backoff, 4xx is not', async () => {
    const f5 = stubFetch((_u, _i, n) => (n < 3 ? { status: 503 } : { body: { state: 'OTP_SENT', sessionId: 's', expiresIn: 60 } }));
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f5, maxRetries: 3 });
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    assert(f5.calls.length === 3, `5xx: 3 calls (got ${f5.calls.length})`);
    const f4 = stubFetch(() => ({ status: 429, body: { errorCode: 'RATE_LIMITED' } }));
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f4, maxRetries: 3 });
    const err = await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch((e) => e);
    assert(err instanceof QuickAuthError && err.status === 429, 'QuickAuthError 429');
    assert(f4.calls.length === 1, `4xx: 1 call (got ${f4.calls.length})`);
    QuickAuth.auth.reset();
  });

  await step('state machine: OTP_SENT → wrong code OTP_FAILED → VERIFIED, device token stored', async () => {
    events.length = 0;
    const f = stubFetch((url, init) => {
      if (url.endsWith('/initiate')) return { body: { state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300, deviceToken: 'dt_offline' } };
      const { code } = JSON.parse(init.body);
      return code === '111111'
        ? { body: { state: 'VERIFIED', requestId: 'req_1', message: 'ok' } }
        : { body: { state: 'OTP_FAILED', message: 'wrong code' } };
    });
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f, onAuthEvent });
    let ev = await callAndWait(() => QuickAuth.auth.initiate({ phone: '+919876543210', channel: 'sms' }), ['OTP_SENT']);
    assert(ev.sessionId === 'sess_1' && ev.channel === 'sms' && ev.expiresIn === 300, 'OTP_SENT payload');
    assert(JSON.parse(localStorageShim.getItem(DEVICE_TOKEN_KEY)) === 'dt_offline', 'device token persisted to localStorage');
    ev = await callAndWait(() => QuickAuth.auth.submitOtp('000000'), ['OTP_FAILED', 'VERIFIED']);
    assert(ev.type === 'OTP_FAILED', 'wrong code → OTP_FAILED');
    ev = await callAndWait(() => QuickAuth.auth.submitOtp('111111'), ['VERIFIED', 'OTP_FAILED']);
    assert(ev.type === 'VERIFIED' && ev.requestId === 'req_1', 'VERIFIED with requestId');
    const verify = f.calls.filter((x) => x.url.endsWith('/verify'));
    assert(JSON.parse(verify[0].init.body).deviceToken === 'dt_offline', 'stored device token sent on verify');
    await expectReject(() => QuickAuth.auth.submitOtp('111111'), /state "verified"/);
  });

  await step('state machine: publishAutoReadCode + autoSubmit → exactly one verify call', async () => {
    events.length = 0;
    const f = stubFetch((url) =>
      url.endsWith('/initiate')
        ? { body: { state: 'OTP_SENT', sessionId: 'sess_2', expiresIn: 300 } }
        : { body: { state: 'VERIFIED', requestId: 'req_2' } }
    );
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f, onAuthEvent });
    await callAndWait(() => QuickAuth.auth.initiate({ phone: '+919876543210', autoSubmit: true }), ['OTP_SENT']);
    const from = events.length;
    QuickAuth.auth.publishAutoReadCode('222222');
    QuickAuth.auth.publishAutoReadCode('222222');
    const ev = await waitForEvent(['VERIFIED', 'OTP_FAILED', 'ERROR'], { from });
    await tick();
    assert(ev.type === 'VERIFIED' && ev.requestId === 'req_2', 'VERIFIED');
    const verifies = f.calls.filter((x) => x.url.endsWith('/verify')).length;
    assert(verifies === 1, `one-shot latch: 1 verify call (got ${verifies})`);
    assert(events.slice(from).filter((e) => e.ev.type === 'OTP_AUTO_READ').length === 2, 'OTP_AUTO_READ per delivered code');
  });

  await step('state machine: OneTap (backend answers VERIFIED on initiate)', async () => {
    const f = stubFetch(() => ({ body: { state: 'VERIFIED', sessionId: 'req_onetap', expiresIn: 0 } }));
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f, onAuthEvent });
    const ev = await callAndWait(() => QuickAuth.auth.initiate({ phone: '+919876543210' }), ['VERIFIED', 'OTP_SENT']);
    assert(ev.type === 'VERIFIED' && ev.requestId === 'req_onetap', 'VERIFIED with no OTP');
  });

  await step('state machine: resendOtp replays phone + channel; ERROR event on 429', async () => {
    const f = stubFetch((_u, _i, n) =>
      n === 1 ? { body: { state: 'OTP_SENT', sessionId: 's', expiresIn: 60 } } : { status: 429, body: { errorCode: 'RATE_LIMITED' } }
    );
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f, onAuthEvent, maxRetries: 0 });
    await callAndWait(() => QuickAuth.auth.initiate({ phone: '+919812345678', channel: 'whatsapp' }), ['OTP_SENT']);
    const ev = await callAndWait(() => QuickAuth.auth.resendOtp(), ['ERROR', 'OTP_SENT']);
    const body = JSON.parse(f.calls[1].init.body);
    assert(body.phone === '+919812345678' && body.channel === 'whatsapp', 'resend body replays the attempt');
    assert(ev.type === 'ERROR' && ev.code === 'RATE_LIMITED', `ERROR RATE_LIMITED (got ${JSON.stringify(ev)})`);
  });

  QuickAuth.auth.reset({ forgetDevice: true });
  await step('auth.reset({ forgetDevice: true }) removes the device token', () => {
    assert(localStorageShim.getItem(DEVICE_TOKEN_KEY) === null, 'qa_device_token removed');
  });

  await step('auth.initiate rejects a non-E.164 phone', async () => {
    for (const bad of ['9876543210', '+0123', 'abc', '']) {
      await expectReject(() => QuickAuth.auth.initiate({ phone: bad }), /E\.164/);
    }
  });

  await step('auth.submitOtp rejects bad code format', async () => {
    for (const bad of ['12', 'abcdef', '123456789']) {
      await expectReject(() => QuickAuth.auth.submitOtp(bad), /4–8 digits/);
    }
  });

  QuickAuth.auth.reset();
  await step('auth.submitOtp rejects when no OTP was sent', () =>
    expectReject(() => QuickAuth.auth.submitOtp('123456'), /state "idle"/)
  );

  await step('auth.resendOtp rejects before initiate()', () =>
    expectReject(() => QuickAuth.auth.resendOtp(), /nothing to resend/)
  );

  await step('auth.observeOTP requires onCode; no-op disposer without WebOTP', () => {
    expectThrowSync(() => QuickAuth.auth.observeOTP({}), /onCode/);
    const dispose = QuickAuth.auth.observeOTP({ onCode: () => {} });
    assert(typeof dispose === 'function', 'returns a disposer');
    dispose();
    dispose();
  });

  await step('consent.get / set / onChange', () => {
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: stubFetch(() => ({})) });
    assert(QuickAuth.consent.get() === false, 'default consent is false');
    const seen = [];
    const off = QuickAuth.consent.onChange((v) => seen.push(v));
    QuickAuth.consent.set(true);
    QuickAuth.consent.set(false);
    off();
    QuickAuth.consent.set(true);
    QuickAuth.consent.set(false);
    assert(JSON.stringify(seen) === '[true,false]', `onChange saw ${JSON.stringify(seen)}`);
  });

  await step('deviceInfo: omitted without consent, RN/Flutter-aligned fields with consent', async () => {
    const f = stubFetch(() => ({ body: { state: 'OTP_SENT', sessionId: 's', expiresIn: 60 } }));
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f, consent: false });
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    assert(!('deviceInfo' in JSON.parse(f.calls[0].init.body)), 'no deviceInfo without consent');
    QuickAuth.consent.set(true);
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    const info = JSON.parse(f.calls[1].init.body).deviceInfo;
    assert(info && info.platform === 'web', `platform=web (got ${info && info.platform})`);
    assert(info.sdk === `web/${PKG_VERSION}`, `sdk (got ${info.sdk})`);
    assert(typeof info.timeZoneOffsetMinutes === 'number' && typeof info.locale === 'string', 'tz offset + locale');
    QuickAuth.consent.set(false);
    QuickAuth.auth.reset();
    return `keys: ${Object.keys(info).join(', ')}`;
  });

  await step('attribution.captureLaunch reads ?qa_clid, no network without consent', async () => {
    const f = stubFetch(() => ({}));
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f });
    locationHref = 'https://shop.example.com/landing?utm_source=wa&qa_clid=clid_offline';
    const r = await QuickAuth.attribution.captureLaunch();
    assert(r.matched === false && r.qaClid === 'clid_offline', `result ${JSON.stringify(r)}`);
    assert(f.calls.length === 0, 'no HTTP call without consent');
    assert(QuickAuth.attribution.qaClid() === 'clid_offline', 'qaClid() returns the stored click id');
    assert(QuickAuth.consent.pendingCount() === 1, 'launch queued until consent');
  });

  await step('conversion + launch queue without consent, both flush on consent.set(true)', async () => {
    const f = stubFetch(() => ({ body: { ok: true } }));
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f });
    await QuickAuth.attribution.trackConversion({ event: 'signup', value: 99 });
    assert(f.calls.length === 0, 'queued, not sent');
    assert((JSON.parse(localStorageShim.getItem('qa_offline_queue')) || []).length === 1, 'queue persisted');
    assert(QuickAuth.consent.pendingCount() === 2, 'conversion + launch pending');
    await QuickAuth.consent.set(true);
    const conv = f.calls.find((x) => x.url.endsWith('/v1/sdk/attribution/conversion'));
    const launch = f.calls.find((x) => x.url.endsWith('/v1/sdk/attribution/launch'));
    assert(conv && launch && f.calls.length === 2, `flushed conversion + queued launch (got ${f.calls.map((x) => x.url).join(', ')})`);
    const body = JSON.parse(conv.init.body);
    assert(
      JSON.stringify(body) === JSON.stringify({ event: 'signup', value: 99, currency: 'INR', qa_clid: 'clid_offline' }),
      `RN-shaped conversion body (got ${conv.init.body})`
    );
    assert(QuickAuth.consent.pendingCount() === 0, 'nothing left pending');
    assert(localStorageShim.getItem('qa_offline_queue') === null, 'queue emptied');
  });

  await step('consent revoke purges queue + stored attribution', async () => {
    QuickAuth.consent.set(false);
    await QuickAuth.attribution.trackConversion({ event: 'x' });
    QuickAuth.consent.set(true);
    QuickAuth.consent.set(false);
    assert(QuickAuth.attribution.getStored() === null, 'attribution cleared');
    assert(localStorageShim.getItem('qa_offline_queue') === null, 'queue cleared');
  });

  await step('attribution.captureLaunch with consent → POST /launch with SHA-256 fingerprint', async () => {
    const f = stubFetch(() => ({ body: { matched: true, campaignId: 'cmp_1' } }));
    QuickAuth.init({ initialToken: fakeJwt(600), fetch: f });
    await QuickAuth.consent.set(true);
    const r = await QuickAuth.attribution.captureLaunch();
    const body = JSON.parse(f.calls[0].init.body);
    assert(r.matched === true && r.campaignId === 'cmp_1', 'merged result');
    assert(/^[0-9a-f]{64}$/.test(body.fingerprint.hash), 'sha-256 hash');
    assert(body.qa_clid === 'clid_offline', 'qa_clid sent');
    QuickAuth.consent.set(false);
    locationHref = 'https://shop.example.com/landing';
    return `hash=${body.fingerprint.hash.slice(0, 12)}…`;
  });

  await step('attribution.trackConversion requires an event name', () =>
    expectReject(() => QuickAuth.attribution.trackConversion({}), /event is required/)
  );

  await step('whatsapp.open builds the wa.me URL and navigates; bad number throws', () => {
    const url = QuickAuth.whatsapp.open({ businessNumber: '+91 98765-43210', message: 'Login please' });
    assert(url === 'https://wa.me/919876543210?text=Login+please', `url (got ${url})`);
    assert(locationHref === url, 'window.location.href assigned');
    expectThrowSync(() => QuickAuth.whatsapp.open({ businessNumber: 'none' }), /must contain digits/);
    expectThrowSync(() => QuickAuth.auth.startWhatsAppLogin({}), /businessNumber required/);
    locationHref = 'https://shop.example.com/landing';
  });

  await step('setAuthEventHandler swaps the handler', async () => {
    let seen = null;
    QuickAuth.setAuthEventHandler((e) => (seen = e));
    QuickAuth.auth.publishAutoReadCode('424242');
    await tick();
    assert(seen && seen.type === 'OTP_AUTO_READ' && seen.code === '424242', 'handler got OTP_AUTO_READ');
    QuickAuth.setAuthEventHandler(null);
  });

  await step('reset() tears down the SDK', () => {
    QuickAuth.reset();
    assert(QuickAuth.isInitialized === false, 'isInitialized false after reset');
    expectThrowSync(() => QuickAuth.config, /not initialised/);
  });

  writeStore(savedStore);
  events.length = 0;
}

let mintCount = 0;
async function backendMintToken() {
  mintCount++;
  const res = await tappedFetch(`${API_BASE}/v1/sdk/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, 'X-Client-Secret': CLIENT_SECRET },
    body: '{}',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`/v1/sdk/session HTTP ${res.status}`), { body });
  const tok = body && (body.sessionToken || body.token);
  if (!tok) throw Object.assign(new Error('/v1/sdk/session returned no sessionToken'), { body });
  return tok;
}

async function initLive() {
  if (MODE === 'publishableKey') {
    QuickAuth.init({ apiBaseUrl: ARGS.api, fetch: tappedFetch, maxRetries: 0, onAuthEvent, publishableKey: PUBLISHABLE_KEY });
    return `publishableKey ${PUBLISHABLE_KEY.slice(0, 8)}… (X-QuickAuth-Key, no session token)`;
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('QA_CLIENT_ID / QA_CLIENT_SECRET are not set — copy e2e/.env.example to e2e/.env and fill it in');
  }
  const base = {
    apiBaseUrl: ARGS.api,
    fetch: tappedFetch,
    maxRetries: 0,
    onAuthEvent,
  };
  if (ARGS.unsafe) {
    const warn = console.warn;
    console.warn = () => {};
    try {
      QuickAuth.init({ ...base, unsafe: { directClientId: CLIENT_ID, directClientSecret: CLIENT_SECRET } });
    } finally {
      console.warn = warn;
    }
    return 'unsafe (SDK mints session tokens itself)';
  }
  QuickAuth.init({ ...base, onTokenExpiry: backendMintToken });
  return 'onTokenExpiry → backend mint (POST /v1/sdk/session)';
}

async function promptPhone() {
  let phone = ARGS.phone;
  while (!phone || !E164.test(phone)) {
    if (phone) console.log(c.red(`    "${phone}" is not E.164 — use +<country code><number>, e.g. +919876543210`));
    phone = (await ask('Phone number to test (E.164, e.g. +919876543210): ')).replace(/[\s-]/g, '');
  }
  return phone;
}

function initiateAndWait(phone, channel, autoSubmit) {
  return callAndWait(() => QuickAuth.auth.initiate({ phone, channel, autoSubmit }), ['OTP_SENT', 'VERIFIED', 'ERROR']);
}

async function liveFlow() {
  section('Phase 2 · Live OTP flow (real API, real SMS)');

  if (!['auto', 'sms', 'whatsapp'].includes(ARGS.channel)) {
    throw new Error(`--channel must be auto, sms or whatsapp (got ${ARGS.channel})`);
  }
  const channel = ARGS.channel;

  if (ARGS.fresh) {
    localStorageShim.removeItem(DEVICE_TOKEN_KEY);
    console.log(c.dim('    --fresh: stored device token cleared'));
  }
  const hadDeviceToken = !!localStorageShim.getItem(DEVICE_TOKEN_KEY);

  const initOk = await step('init() for live API', initLive);
  if (!initOk) return;

  if (MODE === 'publishableKey') {
    await step('publishableKey mode: no session token (tokenManager.getToken rejects)', () =>
      expectReject(() => QuickAuth.tokenManager.getToken(), /publishableKey mode/)
    );
  } else await step('session token: first SDK call mints one, later calls reuse it', async () => {
    const t1 = await QuickAuth.tokenManager.getToken();
    const t2 = await QuickAuth.tokenManager.getToken();
    assert(t1 === t2 && t1.split('.').length === 3, 'JWT cached');
    if (!ARGS.unsafe) assert(mintCount === 1, `one mint (got ${mintCount})`);
    const exp = JSON.parse(Buffer.from(t1.split('.')[1], 'base64url').toString()).exp;
    return exp ? `expires in ${Math.round(exp - Date.now() / 1000)}s` : 'no exp claim (SDK assumes 10 min)';
  });

  const phone = await promptPhone();
  console.log(c.dim(`    phone=${phone} channel=${channel} storedDeviceToken=${hadDeviceToken ? 'yes' : 'no'}`));

  console.log(`\n    How should the OTP you receive be fed into the SDK?`);
  console.log(`      ${c.bold('1')}) manual   — QuickAuth.auth.submitOtp(code)   ${c.dim('(default)')}`);
  console.log(`      ${c.bold('2')}) autoread — simulate WebOTP via publishAutoReadCode + initiate({ autoSubmit: true })`);
  const mode = (await ask('Choose 1 or 2: ')) === '2' ? 'autoread' : 'manual';

  let sent;
  const initiated = await step(`auth.initiate({ phone, channel: '${channel}', autoSubmit: ${mode === 'autoread'} })`, async () => {
    sent = await initiateAndWait(phone, channel, mode === 'autoread');
    if (sent.type === 'ERROR') throw new Error(`ERROR event: ${sent.code} — ${sent.message}${lastServerError()}`);
    if (sent.type === 'VERIFIED') return `OneTap: verified without OTP, requestId=${sent.requestId}`;
    assert(typeof sent.sessionId === 'string' && sent.sessionId, 'OTP_SENT has sessionId');
    assert(typeof sent.expiresIn === 'number', 'OTP_SENT has expiresIn');
    return `OTP_SENT sessionId=${sent.sessionId} expiresIn=${sent.expiresIn}s`;
  });
  if (!initiated) return;

  let verified = sent.type === 'VERIFIED' ? sent : null;

  if (!verified) {
    if (mode === 'manual' && (await confirm('Submit a deliberately WRONG code first to test OTP_FAILED?'))) {
      await step('auth.submitOtp(wrong code) → OTP_FAILED, attempt stays open', async () => {
        const ev = await callAndWait(() => QuickAuth.auth.submitOtp('000000'), ['OTP_FAILED', 'VERIFIED', 'ERROR']);
        assert(ev.type === 'OTP_FAILED', `expected OTP_FAILED, got ${ev.type} ${JSON.stringify(ev)}`);
        return ev.message;
      });
    }

    console.log(`\n    ${c.bold('📱 Check your phone.')} Enter the code you received.`);
    console.log(c.dim(`       Type ${c.bold('r')} to resend, or ${c.bold('q')} to abort.`));

    let latchSpent = false;
    while (!verified) {
      const input = (await ask('OTP: ')).toLowerCase();
      if (input === 'q') {
        skip('verify OTP', 'aborted by user');
        break;
      }
      if (input === 'r' || input === '') {
        await step('auth.resendOtp() → OTP_SENT again', async () => {
          const ev = await callAndWait(() => QuickAuth.auth.resendOtp(), ['OTP_SENT', 'VERIFIED', 'ERROR']);
          if (ev.type === 'ERROR') throw new Error(`ERROR event: ${ev.code} — ${ev.message}${lastServerError()}`);
          if (ev.type === 'VERIFIED') verified = ev;
          latchSpent = false;
          return ev.type === 'OTP_SENT' ? `sessionId=${ev.sessionId}` : 'verified';
        });
        continue;
      }
      if (!/^\d{4,8}$/.test(input)) {
        console.log(c.yellow('    code must be 4–8 digits'));
        continue;
      }

      let outcome;
      if (mode === 'manual' || latchSpent) {
        await step(`auth.submitOtp('${input}')`, async () => {
          outcome = await callAndWait(() => QuickAuth.auth.submitOtp(input), ['VERIFIED', 'OTP_FAILED', 'ERROR']);
          return outcome.type;
        });
      } else {
        await step(`WebOTP delivers '${input}' → OTP_AUTO_READ → auto-submit`, async () => {
          const from = events.length;
          QuickAuth.auth.publishAutoReadCode(input);
          const autoRead = await waitForEvent(['OTP_AUTO_READ'], { from, timeoutMs: 5_000 });
          assert(autoRead.code === input, 'OTP_AUTO_READ carries the code');
          outcome = await waitForEvent(['VERIFIED', 'OTP_FAILED', 'ERROR'], { from });
          return `OTP_AUTO_READ → ${outcome.type}`;
        });
        latchSpent = true;
      }

      if (!outcome) continue;
      if (outcome.type === 'VERIFIED') verified = outcome;
      else if (outcome.type === 'OTP_FAILED') console.log(c.yellow(`    rejected: ${outcome.message} — try again, r to resend`));
      else if (outcome.type === 'ERROR') {
        console.log(c.red(`    ${outcome.code}: ${outcome.message}${lastServerError()}`));
        break;
      }
    }
  }

  return afterVerified(phone, channel, verified);
}

async function afterVerified(phone, channel, verified) {
  if (!verified) {
    skip('post-verification checks', 'phone was not verified');
    return;
  }

  await step('VERIFIED event carries a requestId', () => {
    assert(typeof verified.requestId === 'string' && verified.requestId.length > 0, 'requestId present');
    return `requestId=${verified.requestId}`;
  });

  await step('device token persisted to localStorage (enables OneTap)', () => {
    const tok = localStorageShim.getItem(DEVICE_TOKEN_KEY);
    if (!tok) return 'server did not issue a deviceToken (OneTap may be disabled for this app)';
    return `stored (${tok.length} chars) in e2e/.local-storage.json`;
  });

  await step('auth.submitOtp after VERIFIED is rejected', () =>
    expectReject(() => QuickAuth.auth.submitOtp('123456'), /state "verified"/)
  );

  if (!CLIENT_ID || !CLIENT_SECRET) skip('backend: GET /v1/auth/status', 'QA_CLIENT_ID / QA_CLIENT_SECRET not set');
  else await step('backend: GET /v1/auth/status?requestId=… confirms verification', async () => {
    const res = await realFetch(`${API_BASE}/v1/auth/status?requestId=${encodeURIComponent(verified.requestId)}`, {
      headers: { 'X-Client-Id': CLIENT_ID, 'X-Client-Secret': CLIENT_SECRET, Accept: 'application/json' },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { body });
    const ok = body && (body.authStatus === 'VERIFIED' || body.verified === true);
    const who = body && (body.identity ?? body.phone);
    assert(ok, `authStatus=VERIFIED (got ${JSON.stringify(body)})`);
    if (who) assert(who === phone, `identity matches (got ${who})`);
    return `authStatus=${body.authStatus ?? 'VERIFIED'} identity=${who ?? '?'}`;
  });

  if (await confirm('Send attribution + conversion events (consent on)?', true)) {
    locationHref = 'https://shop.example.com/landing?qa_clid=clid_live_web_script';
    QuickAuth.consent.set(true);
    await step('attribution.captureLaunch with consent → POST /v1/sdk/attribution/launch', async () => {
      const before = httpLog.length;
      const r = await QuickAuth.attribution.captureLaunch();
      const call = httpLog.slice(before).find((e) => e.path.startsWith('/v1/sdk/attribution/launch'));
      assert(call, 'launch request was made');
      assert(call.status && call.status < 400, `HTTP ${call.status ?? call.error}${lastServerError()}`);
      return `HTTP ${call.status} matched=${r.matched}${r.campaignId ? ` campaign=${r.campaignId}` : ''}`;
    });
    await step('attribution.trackConversion → POST /v1/sdk/attribution/conversion', async () => {
      const before = httpLog.length;
      await QuickAuth.attribution.trackConversion({ event: 'e2e_signup', value: 1, metadata: { source: 'web-live-otp-test' } });
      const call = httpLog.slice(before).find((e) => e.path.startsWith('/v1/sdk/attribution/conversion'));
      assert(call, 'conversion request was made');
      assert(call.status && call.status < 400, `HTTP ${call.status ?? call.error}${lastServerError()}`);
      return `HTTP ${call.status}`;
    });
    QuickAuth.consent.set(false);
    locationHref = 'https://shop.example.com/landing';
  } else {
    skip('attribution (live)', 'declined');
  }

  const hasToken = !!localStorageShim.getItem(DEVICE_TOKEN_KEY);
  if (hasToken && (await confirm('Test OneTap now (re-initiate same phone; may send another SMS if OneTap is off)?'))) {
    QuickAuth.auth.reset();
    await step('OneTap: initiate() with stored device token', async () => {
      const ev = await initiateAndWait(phone, channel, false);
      if (ev.type === 'ERROR') throw new Error(`ERROR event: ${ev.code} — ${ev.message}${lastServerError()}`);
      if (ev.type === 'VERIFIED') return `VERIFIED silently, requestId=${ev.requestId}`;
      return 'server sent an OTP instead (OneTap not enabled / token not trusted) — not a failure';
    });
  } else if (!hasToken) {
    skip('OneTap', 'no device token was issued');
  } else {
    skip('OneTap', 'declined');
  }

  const forget = await confirm('Forget the device token at the end (auth.reset({ forgetDevice: true }))?', false);
  await step(`auth.reset(${forget ? '{ forgetDevice: true }' : ''})`, async () => {
    QuickAuth.auth.reset(forget ? { forgetDevice: true } : undefined);
    await expectReject(() => QuickAuth.auth.resendOtp(), /nothing to resend/);
    const tok = localStorageShim.getItem(DEVICE_TOKEN_KEY);
    if (forget) assert(!tok, 'device token removed');
    return forget ? 'device token removed' : `device token kept=${!!tok} (next run should OneTap)`;
  });
}

function summary() {
  section('Summary');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  ${c.red('✘')} ${r.name}: ${r.note}`);
  console.log(`\n  ${c.green(`${pass} passed`)}  ${fail ? c.red(`${fail} failed`) : '0 failed'}  ${c.yellow(`${skipped} skipped`)}`);
  console.log(c.dim(`  ${httpLog.length} live HTTP calls, ${events.length} live auth events`));

  const report = path.join(__dirname, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(
    report,
    JSON.stringify(
      {
        sdk: `web@${QuickAuth.version}`,
        args: { ...ARGS, phone: ARGS.phone ? '[given]' : undefined },
        results,
        events: events.map((e) => e.ev),
        http: httpLog.map((h) => ({ ...h, request: redact(h.request), body: redact(h.body) })),
      },
      null,
      2
    )
  );
  console.log(c.dim(`  report: ${path.relative(process.cwd(), report)}`));
  return fail;
}

(async () => {
  console.log(c.bold(`\nQuickAuth Web SDK — live E2E  (web@${QuickAuth.version}, dist/index.cjs)`));
  console.log(
    c.dim(
      `API: ${API_BASE}   mode: ${ARGS.offline ? 'offline only' : MODE === 'token' ? 'onTokenExpiry' : MODE}   env: ${
        ENV_FILE ? path.relative(process.cwd(), ENV_FILE) : 'shell only'
      }`
    )
  );
  let failed = 0;
  try {
    await offlineChecks();
    if (!ARGS.offline) await liveFlow();
  } catch (err) {
    console.error(c.red(`\nUnexpected error: ${err.stack || err}`));
    results.push({ name: 'script', status: 'FAIL', note: err.message });
  } finally {
    rl.close();
    failed = summary();
  }
  process.exit(failed ? 1 : 0);
})();
