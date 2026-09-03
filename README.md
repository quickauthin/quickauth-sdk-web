# @quickauth/web

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
- **Token-based auth** — short-lived JWTs minted by your backend, never
  embed your client secret in the browser

---

## Install

```bash
npm install @quickauth/web
# or
pnpm add @quickauth/web
# or
yarn add @quickauth/web
```

Or load directly via UMD/IIFE bundle:

```html
<script src="https://unpkg.com/@quickauth/web/dist/index.global.js"></script>
<script>
  // The global is flat: window.QuickAuth.init, not window.QuickAuth.QuickAuth.init.
  QuickAuth.init({
    onTokenExpiry: async () =>
      (await fetch('/api/quickauth-token').then(r => r.json())).sessionToken,
    onAuthEvent: (event) => console.log(event.type, event),
  })
</script>
```

> **1.1.0 users:** that build's global was double-nested
> (`window.QuickAuth.QuickAuth`). It is flat from 1.2.0 on. Drop the extra
> `.QuickAuth` when you upgrade.

Get your `client_id` + `client_secret` from the
[QuickAuth dashboard → Developers → Keys](https://app.quickauth.in/settings/api).

---

## Auth model — short-lived sessionTokens

The Web SDK uses the same pattern as Twilio Verify, Stripe Elements, and
every modern client SDK: your **backend** mints a 10-minute JWT (a
`sessionToken`), and the SDK uses that JWT as a Bearer token. Your
`client_secret` **never** leaves your server.

### 1. Add a token-mint endpoint to your backend (Express example)

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

### 2. Wire the SDK to your endpoint

```js
import { QuickAuth } from '@quickauth/web'

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
import { QuickAuth } from '@quickauth/web'

QuickAuth.init({
  onTokenExpiry: async () =>
    (await fetch('/api/quickauth-token').then(r => r.json())).sessionToken,

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
| `onTokenExpiry`  | `() => Promise<string>` (recommended)   | —                            |
| `initialToken`   | `string`                                | —                            |
| `unsafe`         | `{ directClientId, directClientSecret }`| — (NOT RECOMMENDED)          |
| `apiBaseUrl`     | `string`                                | `https://api.quickauth.in`   |
| `consent`        | `boolean`                               | `false`                      |
| `storagePrefix`  | `string`                                | `qa_`                        |
| `maxRetries`     | `number`                                | `3`                          |
| `fetch`          | `typeof fetch`                          | global `fetch`               |
| `onAuthEvent`    | `(event: AuthEvent) => void`            | —                            |

You **must** provide one of: `onTokenExpiry`, `initialToken`, or `unsafe`.
Otherwise `init()` throws `Error("init() requires an onTokenExpiry callback")`.

If you already have a fresh token at init time (e.g. server-rendered into
the HTML), pass it as `initialToken` to skip the first network round-trip.

### Consent (DPDP / GDPR)

> All tracking endpoints (`captureLaunch`, `trackConversion`, fingerprint
> upload) are **gated by consent**. The SDK ships with consent **off by
> default** — call `QuickAuth.consent.set(true)` only after the user accepts
> your privacy notice.

```ts
QuickAuth.consent.set(true)         // grant — flushes queued events
QuickAuth.consent.set(false)        // revoke — purges queue + cached attribution
QuickAuth.consent.get()             // boolean
QuickAuth.consent.onChange((v) => { /* ... */ })
```

While consent is `false`, conversion events are queued in `localStorage` and
replayed automatically when consent is granted. Revoking consent clears the
queue, the device fingerprint cache, and any stored `qa_clid`.

### Top-level facade

```ts
QuickAuth.init(options)              // configure; safe to call again to reconfigure
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
QuickAuth.auth.initiate({ phone, channel, autoSubmit })  // channel: 'sms' | 'whatsapp' | 'auto'
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
- The WebOTP request is re-armed on every attempt and torn down on `reset()`,
  on supersede, and once the attempt is verified —
  `navigator.credentials.get()` resolves once and is then spent, and a browser
  honours only one outstanding request.
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
```

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
> **Do not use this in browser apps.** Use the `onTokenExpiry` pattern
> instead.

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

The SDK **never** throws on unsupported browsers — it gracefully falls back to
the platform autocomplete attribute, which is enough for iOS QuickType and
most Android keyboards.

---

## Bundle output

`npm run build` emits:

| File                   | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `dist/index.esm.js`    | ESM entry — used by bundlers            |
| `dist/index.cjs`       | CommonJS entry — Node / older bundlers  |
| `dist/index.global.js` | IIFE / UMD-ish — exposes `window.QuickAuth` |
| `dist/index.d.ts`      | TypeScript declarations                  |

Target bundle size: **< 15 KB gzipped**.

The version is single-sourced from `package.json`: it is injected at build time
(`__QA_SDK_VERSION__`) and read by `QuickAuth.version` and the `X-QA-SDK`
request header. There is no second copy to update.

`npm publish` runs `prepublishOnly` — build, tests, then
`scripts/check-dist.mjs`, which refuses to publish a `dist/` that does not carry
the current version and the current API. (1.1.0 went out containing a v0.1.0
build; this is the stop.)

---

## Backend setup

1. Sign in at <https://app.quickauth.in>.
2. Create a project and copy your `client_id` + `client_secret` from
   **Developers → Keys**.
3. Add a `/api/quickauth-token` route to your backend (5-line example
   above) that calls `POST /v1/sdk/session` with `X-Client-Id` +
   `X-Client-Secret`.
4. Wire `QuickAuth.init({ onTokenExpiry })` in your frontend.
5. Configure SMS / WhatsApp templates under **Templates → OTP**.
6. Add your domain to the allowlist under **Settings → Allowed Origins**.
7. Mount your WhatsApp marketing CTA URLs through QuickAuth's link shortener
   to receive a `qa_clid` on every click.

---

## Privacy notes

- `userAgent`, `screen`, `platform` are **hashed locally** via SubtleCrypto
  SHA-256 before leaving the device. Only the hash and three low-entropy hints
  (timezone, locale, platform) are sent.
- Phone numbers are sent only to QuickAuth's `/v1/sdk/auth/*` endpoints and
  are stored encrypted at rest.
- The SDK never reads cookies, never sets third-party cookies, and respects
  `navigator.doNotTrack` if you wire it into `consent.set()`.

---

## License

MIT © QuickAuth
