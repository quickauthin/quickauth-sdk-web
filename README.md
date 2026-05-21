# @quickauth/web

Tiny TypeScript SDK for [QuickAuth](https://quickauth.in) — phone OTP
authentication and Meta WhatsApp marketing attribution for web apps.

- Zero runtime dependencies
- ES2020 modern bundle (ESM + CJS + UMD/IIFE)
- < 15 KB gzipped
- Built-in **DPDP / GDPR** consent gate
- Native **WebOTP** auto-fill (with autocomplete fallback for iOS/Firefox)
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
  QuickAuth.init({
    onTokenExpiry: async () =>
      (await fetch('/api/quickauth-token').then(r => r.json())).sessionToken,
  })
</script>
```

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

```ts
import { QuickAuth } from '@quickauth/web'

QuickAuth.init({
  onTokenExpiry: async () =>
    (await fetch('/api/quickauth-token').then(r => r.json())).sessionToken,
})

// 1. Send OTP
const session = await QuickAuth.auth.startOTP({ phone: '+919876543210' })

// 2. Verify
const { jwt } = await QuickAuth.auth.verifyOTP({
  sessionId: session.sessionId,
  code: '123456',
})

// 3. Send `jwt` to your backend to exchange for a full session.
```

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

### Authentication

```ts
QuickAuth.auth.startOTP({ phone, channel })   // channel: 'sms' | 'whatsapp' | 'auto'
QuickAuth.auth.verifyOTP({ sessionId, code }) // returns { jwt, expiresIn }
QuickAuth.auth.observeOTP({ onCode, input })  // WebOTP + autocomplete fallback
QuickAuth.auth.startWhatsAppLogin({ businessNumber, returnUrl })
```

`observeOTP` will:
1. Stamp `autocomplete="one-time-code"` and `inputmode="numeric"` on your
   target input (so iOS QuickType can offer the SMS code).
2. On Chrome / Edge for Android, call `navigator.credentials.get({ otp })` so
   the OS automatically reads the SMS and fires `onCode(code)`.

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

| Browser              | OTP send/verify | WebOTP auto-fill              | Attribution |
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
