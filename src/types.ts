/**
 * Public type definitions for the QuickAuth Web SDK.
 */

export type OTPChannel = 'sms' | 'whatsapp' | 'auto'

/**
 * Escape hatch for trusted-deployment-only scenarios where the customer
 * accepts embedding their `client_secret` in the browser bundle. Strongly
 * discouraged — see README.
 */
export interface UnsafeDirectCredentials {
  /** Client ID from the QuickAuth dashboard. */
  directClientId?: string
  /** Client secret from the QuickAuth dashboard. */
  directClientSecret?: string
}

export interface InitOptions {
  /** Optional override of the API base URL. Defaults to https://api.quickauth.in */
  apiBaseUrl?: string
  /**
   * REQUIRED — async callback that returns a fresh QuickAuth sessionToken
   * (a short-lived JWT minted by the customer's backend via
   * `POST /v1/sdk/session`). The SDK invokes this when no token is cached
   * or ~30s before the current token expires.
   */
  onTokenExpiry?: () => Promise<string>
  /**
   * OPTIONAL — if the customer already has a fresh sessionToken at init
   * time, pass it here to avoid an immediate `onTokenExpiry` call.
   */
  initialToken?: string
  /**
   * OPTIONAL — UNSAFE escape hatch for trusted-deployment-only setups.
   * When set, the SDK calls `POST /v1/sdk/session` directly using the
   * embedded credentials. Prints a console warning on init.
   */
  unsafe?: UnsafeDirectCredentials
  /**
   * Initial consent value. When false (default) all tracking POSTs are queued
   * locally until the user calls `consent.set(true)`.
   */
  consent?: boolean
  /** Local storage key prefix. Defaults to "qa_". */
  storagePrefix?: string
  /** Maximum retry attempts on 5xx responses (default 3). */
  maxRetries?: number
  /** Optional custom fetch implementation (mainly for tests/SSR). */
  fetch?: typeof fetch
  /**
   * Headless auth event handler. The SDK invokes this with a typed
   * {@link AuthEvent} as the auth lifecycle progresses (OTP sent, verified,
   * failed, error). One handler per init; pass null to {@code QuickAuth.init}
   * again to replace.
   *
   * Events are delivered asynchronously (microtask deferred), so you can
   * safely write {@code await initiate(); /* events fire next tick *\/}
   * without racing your own state updates.
   */
  onAuthEvent?: AuthEventHandler
}

/**
 * One callback for the entire auth lifecycle. Switch on {@link AuthEvent.type}
 * to drive your UI.
 */
export type AuthEventHandler = (event: AuthEvent) => void

/**
 * Typed auth lifecycle events. The SDK guarantees that for any given
 * {@code initiate()} call, you'll see at most one terminal event
 * ({@code VERIFIED} / {@code OTP_FAILED} / {@code ERROR}) for that attempt.
 * Calling {@code initiate()} again resets the state machine.
 *
 * - {@code OTP_SENT} — backend dispatched an OTP. Render the input.
 * - {@code OTP_AUTO_READ} — the SMS code was read automatically (browser
 *   WebOTP API, or fed in via {@code publishAutoReadCode}). Pre-fill the
 *   input. The SDK only submits it for you when the attempt was started with
 *   {@code autoSubmit: true}.
 * - {@code VERIFIED} — user is authenticated. Covers both fresh OTP success
 *   and silent device-trust re-auth (no OTP was sent). Forward
 *   {@code requestId} to your backend.
 * - {@code OTP_FAILED} — the submitted code was rejected. SDK stays in
 *   the awaiting-OTP state so the user can retry.
 * - {@code ERROR} — transport / rate-limit / unexpected failure. Final
 *   for this attempt.
 */
export type AuthEvent =
  | { type: 'OTP_SENT'; sessionId: string; channel: OTPChannel; expiresIn: number }
  | { type: 'OTP_AUTO_READ'; code: string }
  | { type: 'VERIFIED'; requestId: string; message?: string }
  | { type: 'OTP_FAILED'; message: string }
  | { type: 'ERROR'; code: string; message: string }

export interface InitiateOptions {
  /** E.164 phone number, e.g. {@code +919876543210}. */
  phone: string
  /** Delivery channel preference. Server picks if omitted or 'auto'. */
  channel?: OTPChannel
  /**
   * Verify an auto-read code without waiting for the user to press anything.
   *
   * OFF by default: submitting on the merchant's behalf consumes one of the
   * user's verification attempts, so it is opted into, not out of.
   *
   * At most ONE auto-submit happens per {@code initiate()} — a one-shot latch.
   * A code can reach the SDK more than once (an SMS and a WhatsApp copy of the
   * same message, or WebOTP plus your own
   * {@link publishAutoReadCode}); the second submission would verify a code
   * the server has already consumed and surface as a failure arriving after a
   * success.
   *
   * The setting belongs to the attempt, and {@code resendOtp()} carries it
   * forward rather than reverting to the default.
   */
  autoSubmit?: boolean
}

export interface ResetOptions {
  /**
   * Also clear the persistent device token. After reset, the next
   * {@code initiate()} acts like a brand-new install (no OneTap).
   * Use this on user-initiated sign-out from the merchant app.
   */
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

export interface DeviceInfo {
  timezone: string
  locale: string
  screen: { width: number; height: number; colorDepth: number }
  platform: string
  userAgent: string
}

export interface FingerprintEnvelope {
  /** SHA-256 hash of the canonical device payload. */
  hash: string
  /** Subset of low-entropy fields useful for server-side matching. */
  hints: Pick<DeviceInfo, 'timezone' | 'locale' | 'platform'>
}

export interface QueuedRequest {
  id: string
  url: string
  body: unknown
  createdAt: number
  attempts: number
}
