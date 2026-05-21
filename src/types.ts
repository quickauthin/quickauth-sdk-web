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
}

export interface StartOTPOptions {
  phone: string
  channel?: OTPChannel
}

export interface OTPSession {
  sessionId: string
  expiresIn: number
}

export interface VerifyOTPOptions {
  sessionId: string
  code: string
}

export interface VerifyOTPResult {
  jwt: string
  expiresIn: number
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
