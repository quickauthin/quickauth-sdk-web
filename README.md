# @quick-auth/web-sdk

Tiny TypeScript SDK for [QuickAuth](https://quickauth.in) — phone OTP
authentication and Meta WhatsApp marketing attribution for web apps.

- Zero runtime dependencies
- ES2020 modern bundle (ESM + CJS + UMD/IIFE)
- < 15 KB gzipped
- Built-in **DPDP / GDPR** consent gate
- **Headless** — one typed event stream, bring your own UI
- Native **WebOTP** auto-read, armed for you, with opt-in auto-submit
  (autocomplete fallback for iOS/Firefox)
- Idempotent POSTs with exponential-backoff retry and offline queue
- **Publishable-key auth** — drop in a `pk_live_…` key, no backend needed;
  or use short-lived JWTs minted by your backend. Never embed your client
  secret in the browser

---

## Install

```bash
npm install @quick-auth/web-sdk
# or
pnpm add @quick-auth/web-sdk
# or
yarn add @quick-auth/web-sdk
```

Or load directly via UMD/IIFE bundle:

```html
<script src="https://unpkg.com/@quick-auth/web-sdk/dist/index.global.js"></script>
<script>
  // The global is flat: window.QuickAuth.init, not window.QuickAuth.QuickAuth.init.
  QuickAuth.init({
    publishableKey: 'pk_live_…',
    onAuthEvent: (event) => console.log(event.type, event),
  })
</script>
```

> **Upgrading from `@quickauth/web` 1.1.0:** that build's global was
> double-nested (`window.QuickAuth.QuickAuth`). In `@quick-auth/web-sdk` it is
> flat — drop the extra `.QuickAuth`.

Get your keys from the
[QuickAuth dashboard → Developers → Keys](https://app.quickauth.in/settings/api).

---

## Auth model

Pick **one** auth mode in `init()`:

| Mode | What ships in the page | Backend needed? | Use it for |
| --- | --- | --- | --- |
| `publishableKey` | `pk_live_…` (safe to ship) | only to confirm logins | most apps (**recommended**) |
| `onTokenExpiry` | short-lived session JWT | yes, mints tokens | apps that want per-user gating of OTP sends |
| `unsafe` | `client_secret` (**never ship**) | no | trusted, non-browser builds only |

### Publishable key (recommended)

```js
import { QuickAuth } from '@quick-auth/web-sdk'

QuickAuth.init({
  publishableKey: 'pk_live_…', // dashboard → your app → Keys
})
```

A publishable key is designed to ship in the page: it only allows the SDK's
own calls (OTP send/verify and attribution), is meant for your registered
origins (add them under **Settings → Allowed Origins**), and is rate-limited. The SDK sends it as an
`X-QuickAuth-Key` header on every request — no token minting, no token cache,
and a `401` is returned to you as an `ERROR` rather than retried.

### Session tokens (`onTokenExpiry`)

Your **backend** mints a 10-minute JWT (a `sessionToken`), and the SDK uses
that JWT as a Bearer token. Your `client_secret` **never** leaves your server.

#### 1. Add a token-mint endpoint to your backend (Express example)

```js
app.get('/api/quickauth-token', requireAuth, async (req, res) => {
  const r = await fetch('https://api.quickauth.in/v1/sdk/session', {
    method: 'POST',
    headers: {
      'X-Client-Id': process.env.QUICKAUTH_CLIENT_ID,
      'X-Client-Secret': process.env.QUICKAUTH_CLIENT_SECRET,
    },
  })
  res.json(await r.json()) // { sessionToken: '...', expiresIn: 600 }
})
```

The same pattern works in any backend — Next.js Route Handlers, FastAPI,
Rails, Laravel, Cloudflare Workers, etc.

#### 2. Wire the SDK to your endpoint

```js
import { QuickAuth } from '@quick-auth/web-sdk'

QuickAuth.init({
  onTokenExpiry: async () =>
    (await fetch('/api/quickauth-token').then(r => r.json())).sessionToken,
})
```

That's it. The SDK:

- Calls `onTokenExpiry` lazily — only when no token is cached or the
  current one has < 30s remaining.
- Decodes the `exp` claim from the JWT to schedule refreshes (no signature
  verification — that's the server's job).
- Single-flights concurrent refreshes — 100 simultaneous SDK calls during
  a refresh fire **one** `onTokenExpiry` invocation.
- On HTTP 401, invalidates the cache, refreshes once, and retries the
  request.

---

## Quick start

The flow is **headless and event-driven**: you call three methods, and every
outcome arrives on one handler. There is no return value to branch on.

```ts
import { QuickAuth } from '@quick-auth/web-sdk'

QuickAuth.init({
  publishableKey: 'pk_live_…',

  onAuthEvent: (event) => {
    switch (event.type) {
      case 'OTP_SENT':      showOtpInput(event.expiresIn); break
      case 'OTP_AUTO_READ': prefill(event.code); break
      case 'VERIFIED':      finishLogin(event.requestId); break
      case 'OTP_FAILED':    showError(event.message); break   // retry-able
      case 'ERROR':         showError(event.message); break   // attempt is over
    }
  },
})

// 1. Start an attempt. Also arms WebOTP auto-read for you.
await QuickAuth.auth.initiate({ phone: '+919876543210', autoSubmit: true })

// 2. Verify the code the user typed (skip this when autoSubmit did it).
await QuickAuth.auth.submitOtp('123456')

// 3. Same number, same channel, no arguments.
await QuickAuth.auth.resendOtp()

// Forward `requestId` from the VERIFIED event to your backend, which confirms
// with QuickAuth server-to-server (GET /v1/auth/status?requestId=...) and
// mints its own session. QuickAuth is verification-only — your backend owns
// the session. See https://quickauth.in/docs/backend
```

`VERIFIED` also covers silent device-trust re-auth: when the browser is already
trusted, `initiate()` emits `VERIFIED` and no OTP screen is needed at all.

---

## API reference

### `QuickAuth.init(options)`

| Option           | Type                                    | Default                      |
| ---------------- | --------------------------------------- | ---------------------------- |
| `publishableKey` | `string` (recommended)                  | —                            |
| `onTokenExpiry`  | `() => Promise<string>`                 | —                            |
| `initialToken`   | `string`                                | —                            |
| `unsafe`         | `{ directClientId, directClientSecret }`| — (NOT RECOMMENDED)          |
| `apiBaseUrl`     | `string`                                | `https://api.quickauth.in`   |
| `consent`        | `boolean`                               | `false`                      |
| `storagePrefix`  | `string`                                | `qa_`                        |
| `maxRetries`     | `number`                                | `3`                          |
| `requestTimeoutMs` | `number` (0 disables)                 | `15000`                      |
| `debug`          | `boolean`                               | `false`                      |
| `silent`         | `boolean`                               | `false`                      |
| `fetch`          | `typeof fetch`                          | global `fetch`               |
| `onAuthEvent`    | `(event: AuthEvent) => void`            | —                            |

You **must** provide one of: `publishableKey` (recommended), `onTokenExpiry`,
`initialToken`, or `unsafe`. `publishableKey` cannot be combined with any of
the others, and `onTokenExpiry` cannot be combined with `unsafe`. Invalid
options throw straight away:

- `[QuickAuth] init() requires one of: publishableKey (recommended), onTokenExpiry, initialToken, or unsafe.{directClientId, directClientSecret}`
- `[QuickAuth] init() accepts only one auth mode: publishableKey cannot be combined with onTokenExpiry, initialToken or unsafe`
- `[QuickAuth] init() accepts only one auth mode: pass either onTokenExpiry or unsafe — not both`
- `[QuickAuth] init() publishableKey must be a string`
- `[QuickAuth] init() unsafe needs both directClientId and directClientSecret`
- `[QuickAuth] init() onTokenExpiry must be a function that returns a session token`

`init()` returns a promise that settles once anything queued for consent has
been sent. Awaiting it is optional, and it never rejects.

In session-token mode, if you already have a fresh token at init time (e.g.
server-rendered into the HTML), pass it as `initialToken` to skip the first
network round-trip.

### Errors

Failures arrive as an `ERROR` event (and the method's promise rejects with a
`QuickAuthError` carrying the same fields):

```ts
{
  type: 'ERROR',
  code: 'CLIENT_ERROR',                       // SDK category — table below
  message: '[QuickAuth] HTTP 400: phone: phone is required',  // includes the server's message
  errorCode: 'INVALID_REQUEST',               // the server's reason, when it sent one
  status: 400,                                // HTTP status, when the server answered
  retryAfter: 120,                            // seconds to wait (rate limits)
  requestId: 'f3c1…',                         // quote this to QuickAuth support
}
```

| `code`          | Meaning                                                   | Retried by the SDK |
| --------------- | --------------------------------------------------------- | ------------------ |
| `CLIENT_ERROR`  | 4xx — the request was rejected; see `errorCode`           | no                 |
| `RATE_LIMITED`  | 429 — wait `retryAfter` seconds before trying again       | no                 |
| `SERVER_ERROR`  | 5xx, or a 2xx the SDK cannot use (`errorCode: 'INVALID_RESPONSE'`) | 5xx yes, `INVALID_RESPONSE` no |
| `NETWORK_ERROR` | offline, DNS failure, blocked by CORS (Allowed Origins), or the connection dropped mid-response | yes, `maxRetries` |
| `TIMEOUT`       | no complete response within `requestTimeoutMs` (the body read counts) | yes, `maxRetries`  |
| `TOKEN_ERROR`   | `onTokenExpiry` threw or returned nothing, or the unsafe mint was rejected | no |
| `UNKNOWN_ERROR` | anything else                                             | no                 |

A wrong code is not an error — it is `OTP_FAILED`, and the attempt stays open.

`INVALID_RESPONSE` means a successful response that is not the QuickAuth API's:
an HTML page (a public Wi-Fi login page, or a wrong `apiBaseUrl`), or an
initiate without `sessionId` / a verify without `state` or `requestId`. It is
not retried, because the request may already have sent an SMS:

```ts
{
  type: 'ERROR',
  code: 'SERVER_ERROR',
  errorCode: 'INVALID_RESPONSE',
  status: 200,
  message: '[QuickAuth] Unexpected response from the server (HTTP 200, text/html) for /v1/sdk/auth/initiate — not the QuickAuth API. Check apiBaseUrl, or the network may be behind a login page (public Wi-Fi).',
}
```

`retryAfter` is read from the response body, or from the `Retry-After` header
when the API exposes it to the browser.

### Debug logging

`init({ debug: true })` logs every request, response, retry, token refresh and
auth event to the console, prefixed `[QuickAuth]`. OTP codes, tokens and
secrets are masked. Leave it off in production. `silent: true` does the
opposite: it hides the SDK's own warnings (e.g. the `unsafe` warning) and
errors.

### Consent (DPDP / GDPR)

> All tracking endpoints (`captureLaunch`, `trackConversion`, fingerprint
> upload) are **gated by consent**. The SDK ships with consent **off by
> default** — call `QuickAuth.consent.set(true)` only after the user accepts
> your privacy notice.

```ts
await QuickAuth.consent.set(true)   // grant — sends everything queued
await QuickAuth.consent.set(false)  // revoke — drops the queue + stored attribution
QuickAuth.consent.get()             // boolean
QuickAuth.consent.pendingCount()    // requests waiting for consent
QuickAuth.consent.onChange((v) => { /* ... */ })
```

The user's choice is saved in `localStorage` and **wins over
`init({ consent })`** on later page loads, so passing `consent: false` on every
load never wipes out a "yes" (same as the React Native and Flutter SDKs).
`init({ consent })` only applies when nothing has been saved yet.

While consent is `false`, `captureLaunch()` and conversion events are queued
and sent automatically when consent is granted. Revoking consent clears the
queue and any stored `qa_clid`.

### Top-level facade

```ts
QuickAuth.init(options)              // configure (returns a promise); safe to call again
QuickAuth.isInitialized              // boolean
QuickAuth.config                     // resolved config (throws before init)
QuickAuth.version                    // semver of this build
QuickAuth.tokenManager               // { getToken(), invalidate() }
QuickAuth.setAuthEventHandler(fn)    // attach/replace the handler after init; null detaches
QuickAuth.consent                    // DPDP / GDPR gate
QuickAuth.auth                       // the OTP state machine (below)
QuickAuth.attribution                // click attribution + conversions
QuickAuth.whatsapp.open(opts)        // raw wa.me deep link
QuickAuth.reset()                    // tear the SDK back down to pre-init
```

`QuickAuth.reset()` is the whole-SDK teardown — it clears the configuration, so
`init()` must be called again afterwards. To end a login attempt while staying
initialised (including sign-out), use `QuickAuth.auth.reset({ forgetDevice: true })`.

### Authentication

```ts
QuickAuth.auth.initiate({ phone, channel, autoSubmit })  // E.164, surrounding spaces trimmed
QuickAuth.auth.submitOtp(code)                           // 4–8 digits
QuickAuth.auth.resendOtp()                               // no arguments — see below
QuickAuth.auth.publishAutoReadCode(code)                 // feed a code in yourself
QuickAuth.auth.reset({ forgetDevice })                   // end the attempt
QuickAuth.auth.observeOTP({ onCode, input })             // optional: codes in a callback
QuickAuth.auth.startWhatsAppLogin({ businessNumber, returnUrl })
```

Every method reports through `onAuthEvent`. The returned promises resolve when
the network call completes; treat the events as the source of truth for what to
render. Concurrent `initiate()` calls are latest-wins — the older attempt is
dropped and its late responses are discarded.

**`resendOtp()` takes no phone number, deliberately.** It replays the number the
current attempt is already for, carrying that attempt's `channel` and
`autoSubmit` forward. Asking for the number again is an opportunity to pass a
different one by accident, which starts a second transaction and leaves the user
holding two codes, only one of which works. Within your expiry window the server
returns the *same* code and extends it; past the window it issues a fresh one.
It rejects when there is no attempt to resend — a resend button should only
exist after `OTP_SENT`.

### Auto-read and auto-submit

`initiate()` arms WebOTP itself. You do **not** have to call `observeOTP` to get
`OTP_AUTO_READ` events or auto-submit — a caller who never subscribes to
anything still gets both.

```ts
await QuickAuth.auth.initiate({ phone, autoSubmit: true })
// Chrome/Android: OS reads the SMS → OTP_AUTO_READ → SDK verifies → VERIFIED
```

- `autoSubmit` is **off by default**. Submitting on your behalf spends one of
  the user's verification attempts, so it is opted into.
- At most **one** auto-submit happens per attempt. A code can reach the SDK
  twice (an SMS and a WhatsApp copy of the same message, or WebOTP plus your own
  `publishAutoReadCode`); the second submission would verify a code the server
  has already consumed and would surface as a failure arriving *after* a
  success.
- One WebOTP request is shared by everything listening. A pending request is
  kept across a resend or a new attempt (aborting and re-issuing it makes
  Chrome on Android show the consent prompt for a request that no longer
  delivers); a new one is armed only once the previous one has resolved. It is
  torn down on `reset()` and once the attempt is verified.
- **The SMS must end with an origin-bound line** or the browser ignores it:
  `@shop.example.com #123456` — your page's host, then the code. Configure it in
  your OTP SMS template; it is the browser's rule, not the SDK's.
- `publishAutoReadCode(code)` feeds a code in from anywhere else (your own SMS
  webhook, a paste handler, a native shell). It behaves exactly as a WebOTP read
  does, including the one-shot latch.

`observeOTP` remains available when you want the code in a callback or the input
auto-filled. It:
1. Stamps `autocomplete="one-time-code"` and `inputmode="numeric"` on your
   target input (so iOS QuickType can offer the SMS code).
2. Shares the SDK's single WebOTP request rather than starting a competing one.

It does **not** emit `OTP_AUTO_READ` itself — the state machine does, exactly
once per code, so a merchant listening to both does not see the same code twice.

### Attribution

```ts
const r = await QuickAuth.attribution.captureLaunch()
// { matched, campaignId?, templateId?, variantId?, qaClid? }

await QuickAuth.attribution.trackConversion({
  event: 'signup',
  value: 0,
  currency: 'INR',
  metadata: { plan: 'free' },
})

QuickAuth.attribution.getStored() // most recent attribution snapshot
QuickAuth.attribution.qaClid()    // click id of the most recent WhatsApp click, or null
```

`trackConversion()` sends `{ event, value, currency, qa_clid?, metadata? }`, the
same body as the React Native and Flutter SDKs. It is best-effort: a network
failure is logged (with `debug: true`) instead of rejecting, so a conversion can
never break your page. A missing event name still throws.

`captureLaunch()` looks for a `?qa_clid=...` query parameter (set by your
WhatsApp template CTA URL). When found and consent is granted, it sends an
opaque SHA-256 device fingerprint to QuickAuth so the click can be matched
back to the originating campaign / template / variant.

---

## Unsafe escape hatch (not recommended)

For trusted-deployment-only setups (a Node CLI you ship to internal users,
an Electron app shipped to enterprise customers under contract, server-side
rendering where the bundle never reaches a browser), you can let the SDK
mint tokens directly using your client credentials:

```ts
QuickAuth.init({
  unsafe: {
    directClientId:     process.env.QUICKAUTH_CLIENT_ID!,
    directClientSecret: process.env.QUICKAUTH_CLIENT_SECRET!,
  },
})
```

> **WARNING.** This embeds your `client_secret` in whatever environment
> the bundle runs in. If that environment is a public web page, **anyone**
> can extract it from the JS bundle and impersonate your project. The SDK
> prints a `console.warn("[QuickAuth] UNSAFE: client_secret embedded in
> client...")` on init as a reminder.
>
> **Do not use this in browser apps.** Use `publishableKey` (or the
> `onTokenExpiry` pattern) instead.

---

## Browser compatibility

| Browser              | OTP send/verify | WebOTP auto-read              | Attribution |
| -------------------- | --------------- | ----------------------------- | ----------- |
| Chrome (Android)     | ✅              | ✅                            | ✅          |
| Edge (Android)       | ✅              | ✅                            | ✅          |
| Samsung Internet     | ✅              | ✅                            | ✅          |
| iOS Safari           | ✅              | ⚠️ autocomplete fallback only | ✅          |
| Firefox (all)        | ✅              | ⚠️ autocomplete fallback only | ✅          |
| Desktop Chrome/Edge  | ✅              | ❌ (no WebOTP on desktop)     | ✅          |

WebOTP needs a secure page (HTTPS, or `localhost` while developing) and the
origin-bound SMS line above. The SDK **never** throws on unsupported browsers —
it falls back to the `autocomplete="one-time-code"` attribute, so iOS QuickType
and most Android keyboards offer the code. That fallback fills the input but
does not emit `OTP_AUTO_READ`, so call `submitOtp()` from your input handler
there.

---

## Bundle output

`npm run build` emits:

| File                   | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `dist/index.esm.js`    | ESM entry — used by bundlers            |
| `dist/index.cjs`       | CommonJS entry — Node / older bundlers  |
| `dist/index.global.js` | IIFE / UMD-ish — exposes `window.QuickAuth` |
| `dist/index.d.ts`      | TypeScript declarations                  |

Bundle size: **~9 KB gzipped** (target < 15 KB).

The version is single-sourced from `package.json`: it is injected at build time
(`__QA_SDK_VERSION__`) and read by `QuickAuth.version` and `deviceInfo.sdk`.
There is no second copy to update. (Unlike the React Native and Flutter SDKs,
the web SDK sends no `X-QA-SDK` header — browsers would need the API's CORS
policy to allow it.)

`npm publish` runs `prepublishOnly` — build, tests, then
`scripts/check-dist.mjs`, which refuses to publish a `dist/` that does not carry
the current version and the current API. (1.1.0 went out containing a v0.1.0
build; this is the stop.)

---

## Backend setup

1. Sign in at <https://app.quickauth.in>.
2. Create a project and copy your publishable key (`pk_live_…`) from
   **Developers → Keys**.
3. Add your domain to the allowlist under **Settings → Allowed Origins** —
   the publishable key only works from these origins.
4. Wire `QuickAuth.init({ publishableKey })` in your frontend.
   (Session-token mode instead: add a `/api/quickauth-token` route that calls
   `POST /v1/sdk/session` with `X-Client-Id` + `X-Client-Secret`, and wire
   `QuickAuth.init({ onTokenExpiry })`.)
5. Configure SMS / WhatsApp templates under **Templates → OTP**.
6. Mount your WhatsApp marketing CTA URLs through QuickAuth's link shortener
   to receive a `qa_clid` on every click.

---

## Device info

With consent granted, `initiate()`, `submitOtp()` and `captureLaunch()` attach
a `deviceInfo` block (audit metadata — never used for OneTap). Without consent
it is not sent at all. The first six fields match the React Native and Flutter
SDKs, so the backend reads every platform the same way:

```jsonc
{
  "platform": "web",
  "osVersion": "Android 14",           // from User-Agent Client Hints when available
  "locale": "en-IN",
  "timeZoneOffsetMinutes": 330,
  "appId": "shop.example.com",         // location.host
  "sdk": "web/1.0.1",
  // web-only
  "osName": "Android",
  "browserName": "Chrome",
  "browserVersion": "141.0.7390.55",
  "mobile": true,
  "timezone": "Asia/Kolkata",
  "userAgent": "Mozilla/5.0 (…)",
  "screen": { "width": 412, "height": 915, "colorDepth": 24, "pixelRatio": 2.625 }
}
```

On Chromium browsers the exact OS and browser versions come from User-Agent
Client Hints (which tell Windows 11 from 10 and give the real macOS version);
elsewhere they are parsed from the User-Agent string. Fields a browser does not
expose are omitted. Client hints are awaited for at most 250 ms, so they never
hold up a login.

## Privacy notes

- The attribution **fingerprint** hashes `userAgent`, `screen`, `platform`,
  timezone and locale **locally** via SubtleCrypto SHA-256; only the hash and
  three low-entropy hints (timezone, locale, platform) are sent with it.
- The `deviceInfo` block above is sent in clear, and only with consent.
- Phone numbers are sent only to QuickAuth's `/v1/sdk/auth/*` endpoints and
  are stored encrypted at rest.
- The SDK never reads cookies, never sets third-party cookies, and respects
  `navigator.doNotTrack` if you wire it into `consent.set()`.

---

## License

MIT © QuickAuth
