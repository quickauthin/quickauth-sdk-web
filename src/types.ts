export type OTPChannel = 'sms' | 'whatsapp' | 'auto'

/** Escape hatch for trusted-deployment-only scenarios where the customer accepts embedding their `client_secret` in the browser bundle. */
export interface UnsafeDirectCredentials {
  /** Client ID from the QuickAuth dashboard. */
  directClientId?: string
  /** Client secret from the QuickAuth dashboard. */
  directClientSecret?: string
}

export interface InitOptions {
  /** Optional override of the API base URL. */
  apiBaseUrl?: string
  /**
   * RECOMMENDED — publishable key (`pk_live_…` / `pk_test_…`), safe to ship in the page.
   * Scoped to OTP initiate/verify, locked to your registered origins and rate-limited.
   * No backend or session token needed. Use exactly one of `publishableKey`, `onTokenExpiry` or `unsafe`.
   */
  publishableKey?: string
  /** Async callback that returns a fresh QuickAuth sessionToken (a short-lived JWT minted by the customer's backend via `POST /v1/sdk/session`). */
  onTokenExpiry?: () => Promise<string>
  /** OPTIONAL — if the customer already has a fresh sessionToken at init time, pass it here to avoid an immediate `onTokenExpiry` call. Not used with `publishableKey`. */
  initialToken?: string
  /** OPTIONAL — UNSAFE escape hatch for trusted-deployment-only setups. */
  unsafe?: UnsafeDirectCredentials
  /** Initial consent value. */
  consent?: boolean
  /** Local storage key prefix. */
  storagePrefix?: string
  /** Maximum retry attempts on 5xx responses and network errors (default 3). */
  maxRetries?: number
  /** Per-request timeout in milliseconds (default 15000; 0 disables). */
  requestTimeoutMs?: number
  /** Log every request, response and auth event to the console (secrets and OTP codes masked). */
  debug?: boolean
  /** Suppress the SDK's console warnings and errors. */
  silent?: boolean
  /** Optional custom fetch implementation (mainly for tests/SSR). */
  fetch?: typeof fetch
  /** Headless auth event handler. */
  onAuthEvent?: AuthEventHandler
}

/** One callback for the entire auth lifecycle. */
export type AuthEventHandler = (event: AuthEvent) => void

/** Typed auth lifecycle events. */
export type AuthEvent =
  | { type: 'OTP_SENT'; sessionId: string; channel: OTPChannel; expiresIn: number }
  | { type: 'OTP_AUTO_READ'; code: string }
  | { type: 'VERIFIED'; requestId: string; message?: string }
  | { type: 'OTP_FAILED'; message: string }
  | {
      type: 'ERROR'
      /** SDK category — see {@link QuickAuthErrorCode}. */
      code: QuickAuthErrorCode
      /** Human-readable reason, including the server's own message when it sent one. */
      message: string
      /** The server's machine-readable reason, e.g. `INVALID_REQUEST`. */
      errorCode?: string
      /** HTTP status, when the server answered. */
      status?: number
      /** Seconds to wait before retrying (rate limits). */
      retryAfter?: number
      /** The server's request id, for support tickets. */
      requestId?: string
    }

/** Category of an `ERROR` event or thrown `QuickAuthError`. */
export type QuickAuthErrorCode =
  | 'RATE_LIMITED'
  | 'CLIENT_ERROR'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'TOKEN_ERROR'
  | 'UNKNOWN_ERROR'

export interface InitiateOptions {
  /** E.164 phone number, e.g. {@code +919876543210}. */
  phone: string
  /** Delivery channel preference. */
  channel?: OTPChannel
  /** Verify an auto-read code without waiting for the user to press anything. */
  autoSubmit?: boolean
}

export interface ResetOptions {
  /** Also clear the persistent device token. */
  forgetDevice?: boolean
}

export interface WhatsAppLoginOptions {
  businessNumber: string
  returnUrl?: string
  message?: string
}

export interface ObserveOTPOptions {
  onCode: (code: string) => void
  onError?: (err: unknown) => void
  /** AbortSignal for the underlying WebOTP credential request. */
  signal?: AbortSignal
  /** CSS selector or input element to stamp `autocomplete="one-time-code"` on. */
  input?: string | HTMLInputElement
}

export interface AttributionResult {
  matched: boolean
  campaignId?: string
  templateId?: string
  variantId?: string
  qaClid?: string
}

export interface TrackConversionOptions {
  event: string
  value?: number
  currency?: string
  metadata?: Record<string, unknown>
}

/** The `deviceInfo` block sent with initiate / verify (only with consent) and attribution launches. */
export interface DeviceInfo {
  /** Always `"web"` — the RN/Flutter SDKs send `"ios"` / `"android"`. */
  platform: 'web'
  /** e.g. `"Android 14"`, `"iOS 17.5"`, `"Windows 11"`, `"macOS 15.6"`. */
  osVersion?: string
  /** BCP-47, e.g. `"en-IN"`. */
  locale: string
  /** Minutes east of UTC, e.g. `330` for IST. */
  timeZoneOffsetMinutes: number
  /** The page's host, e.g. `"shop.example.com"` — the web analogue of a bundle id. */
  appId?: string
  /** `web/<version>` — the SDK and version that sent the request. */
  sdk: string
  /** e.g. `"Android"`, `"iOS"`, `"Windows"`, `"macOS"`. */
  osName?: string
  /** e.g. `"Chrome"`, `"Safari"`, `"Edge"`, `"Samsung Internet"`. */
  browserName?: string
  /** e.g. `"141.0.7390.55"` (Chromium full version) or `"17.5"`. */
  browserVersion?: string
  /** Phone-class device. */
  mobile?: boolean
  /** IANA zone, e.g. `"Asia/Kolkata"`. */
  timezone: string
  userAgent: string
  screen: { width: number; height: number; colorDepth: number; pixelRatio: number }
}

/** Raw browser signals the attribution fingerprint is hashed from. */
export interface BrowserSignals {
  timezone: string
  locale: string
  screen: { width: number; height: number; colorDepth: number }
  /** `navigator.platform`, e.g. `"MacIntel"`, `"Linux armv8l"`. */
  platform: string
  userAgent: string
}

export interface FingerprintEnvelope {
  /** SHA-256 hash of the canonical device payload. */
  hash: string
  /** Subset of low-entropy fields useful for server-side matching. */
  hints: Pick<BrowserSignals, 'timezone' | 'locale' | 'platform'>
}

export interface QueuedRequest {
  id: string
  url: string
  body: unknown
  createdAt: number
  attempts: number
}
