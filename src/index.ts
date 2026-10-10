import {
  initiate,
  publishAutoReadCode,
  resendOtp,
  reset as resetAuth,
  submitOtp,
} from './auth/session'
import { startWhatsAppLogin } from './auth/whatsapp'
import { observeOTP } from './auth/webotp'
import {
  captureLaunch,
  clearAttribution,
  flushPendingLaunch,
  getQaClid,
  getStoredAttribution,
  hasPendingLaunch,
} from './attribution/capture'
import { trackConversion } from './attribution/track'
import { clearQueue, flushQueue, queueLength, QuickAuthError } from './core/client'
import {
  configure,
  getConfig,
  isConfigured,
  __resetConfig,
  type ResolvedConfig,
} from './core/config'
import { consent as consentStore } from './core/consent'
import { setAuthEventHandler } from './core/events'
import { logger } from './core/logger'
import { storage } from './core/storage'
import { tokenManager, __resetTokenManager } from './core/token'
import type { InitOptions } from './types'
import { SDK_VERSION } from './version'

export type {
  AttributionResult,
  AuthEvent,
  AuthEventHandler,
  BrowserSignals,
  DeviceInfo,
  FingerprintEnvelope,
  InitiateOptions,
  InitOptions,
  ObserveOTPOptions,
  OTPChannel,
  QuickAuthErrorCode,
  ResetOptions,
  TrackConversionOptions,
  WhatsAppLoginOptions,
} from './types'
export type { ResolvedConfig } from './core/config'

export { QuickAuthError }

function flushPending(): Promise<void> {
  return Promise.all([flushQueue(), flushPendingLaunch()]).then(
    () => undefined,
    (err) => logger.debug('flushing queued requests failed:', err),
  )
}

const consent = {
  get: (): boolean => consentStore.get(),
  /** Record the user's choice; granting sends anything queued, revoking drops it. */
  set: (value: boolean): Promise<void> => {
    const previous = consentStore.get()
    consentStore.set(value)
    if (!value && previous) {
      clearQueue()
      clearAttribution()
    }
    return value && !previous ? flushPending() : Promise.resolve()
  },
  onChange: consentStore.onChange,
  /** Requests waiting for consent. */
  pendingCount: (): number => queueLength() + (hasPendingLaunch() ? 1 : 0),
}

const auth = {
  initiate,
  submitOtp,
  resendOtp,
  publishAutoReadCode,
  reset: resetAuth,
  observeOTP,
  startWhatsAppLogin,
}

const attribution = {
  captureLaunch,
  trackConversion,
  getStored: getStoredAttribution,
  qaClid: getQaClid,
}

/** Direct WhatsApp deep-link helper. */
const whatsapp = {
  open: startWhatsAppLogin,
}

export const QuickAuth = {
  /** Semver of this build. */
  version: SDK_VERSION,

  /** Configure the SDK. Throws on invalid options; the promise settles once queued requests are sent. */
  init(options: InitOptions): Promise<void> {
    const cfg = configure(options)
    __resetTokenManager()
    consentStore.hydrate(options.consent)
    logger.debug(
      `init web@${SDK_VERSION}`,
      {
        apiBaseUrl: cfg.apiBaseUrl,
        auth: cfg.publishableKey
          ? 'publishableKey'
          : cfg.onTokenExpiry
            ? 'onTokenExpiry'
            : cfg.unsafe
              ? 'unsafe'
              : 'initialToken',
        consent: consentStore.get(),
        maxRetries: cfg.maxRetries,
        requestTimeoutMs: cfg.requestTimeoutMs,
      },
    )
    return consentStore.get() ? flushPending() : Promise.resolve()
  },

  /** Whether {@link init} has run. */
  get isInitialized(): boolean {
    return isConfigured()
  },

  /** The resolved active configuration. */
  get config(): ResolvedConfig {
    return getConfig()
  },

  /** Token cache — `getToken()` / `invalidate()`. */
  tokenManager,

  /** Replace the auth event handler after init — useful when the handler belongs to a component that mounts later than your `init()` call. */
  setAuthEventHandler,

  consent,
  auth,
  attribution,
  whatsapp,

  /** Tear the SDK back down to its pre-`init()` state: auth state machine reset, WebOTP disarmed, token cache dropped, event handler detached, configuration cleared. */
  reset(): void {
    resetAuth()
    setAuthEventHandler(null)
    __resetTokenManager()
    __resetConfig()
  },

  /** Error class thrown for non-2xx API responses. */
  QuickAuthError,

  /** @deprecated Use {@link QuickAuth.isInitialized}. */
  isConfigured,

  /** @deprecated Promoted to the facade: `tokenManager`, `setAuthEventHandler`. */
  _internal: { storage, flushQueue, tokenManager, setAuthEventHandler },
}
