/**
 * @quickauth/web — headless phone auth + WhatsApp marketing attribution.
 *
 *   import { QuickAuth } from '@quickauth/web'
 *
 *   QuickAuth.init({
 *     onTokenExpiry: async () =>
 *       (await fetch('/api/quickauth-token').then(r => r.json())).sessionToken,
 *     onAuthEvent: (event) => {
 *       switch (event.type) {
 *         case 'OTP_SENT':   showOtpInput(); break
 *         case 'OTP_AUTO_READ': prefillInput(event.code); break
 *         case 'VERIFIED':   finishLogin(event.requestId); break
 *         case 'OTP_FAILED': showError(event.message); break
 *         case 'ERROR':      showError(event.message); break
 *       }
 *     },
 *   })
 *
 *   await QuickAuth.auth.initiate({ phone: '+919876543210', autoSubmit: true })
 *   // OTP_SENT arrives; on Chrome/Android the code is auto-read and — because
 *   // autoSubmit is on — verified without the user pressing anything.
 *   await QuickAuth.auth.submitOtp('123456')   // manual entry path
 *   await QuickAuth.auth.resendOtp()           // same number, same channel
 *
 *   // On user-initiated sign-out:
 *   QuickAuth.auth.reset({ forgetDevice: true })
 *
 * The `onTokenExpiry` callback must return a fresh `sessionToken` (a
 * short-lived JWT minted by your backend via `POST /v1/sdk/session` with
 * your `X-Client-Id` + `X-Client-Secret`). The SDK auto-refreshes the
 * token ~30s before it expires, so the callback is invoked rarely.
 */

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
  getStoredAttribution,
} from './attribution/capture'
import { trackConversion } from './attribution/track'
import { clearQueue, flushQueue, QuickAuthError } from './core/client'
import {
  configure,
  getConfig,
  isConfigured,
  __resetConfig,
  type ResolvedConfig,
} from './core/config'
import { consent as consentStore } from './core/consent'
import { setAuthEventHandler } from './core/events'
import { storage } from './core/storage'
import { tokenManager, __resetTokenManager } from './core/token'
import type { InitOptions } from './types'
import { SDK_VERSION } from './version'

export type {
  AttributionResult,
  AuthEvent,
  AuthEventHandler,
  DeviceInfo,
  FingerprintEnvelope,
  InitiateOptions,
  InitOptions,
  ObserveOTPOptions,
  OTPChannel,
  ResetOptions,
  TrackConversionOptions,
  WhatsAppLoginOptions,
} from './types'
export type { ResolvedConfig } from './core/config'

export { QuickAuthError }

const consent = {
  get: (): boolean => consentStore.get(),
  set: (value: boolean): void => {
    const previous = consentStore.get()
    consentStore.set(value)
    if (!value && previous) {
      clearQueue()
      clearAttribution()
    }
    if (value && !previous) {
      void flushQueue()
    }
  },
  onChange: consentStore.onChange,
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
}

/**
 * Direct WhatsApp deep-link helper. Most apps should prefer
 * `QuickAuth.auth.startWhatsAppLogin(...)`, which is the same call named for
 * the flow it belongs to.
 */
const whatsapp = {
  open: startWhatsAppLogin,
}

export const QuickAuth = {
  /** Semver of this build. Single-sourced from package.json — see src/version.ts. */
  version: SDK_VERSION,

  init(options: InitOptions): void {
    configure(options)
    __resetTokenManager()
    consentStore.hydrate(options.consent)
    if (consentStore.get()) {
      void flushQueue()
    }
  },

  /** Whether {@link init} has run. */
  get isInitialized(): boolean {
    return isConfigured()
  },

  /** The resolved active configuration. Throws when {@link init} has not run. */
  get config(): ResolvedConfig {
    return getConfig()
  },

  /**
   * Token cache — `getToken()` / `invalidate()`. Exposed for advanced flows
   * (forcing a refresh after your backend rotates credentials) and tests.
   */
  tokenManager,

  /**
   * Replace the auth event handler after init — useful when the handler
   * belongs to a component that mounts later than your `init()` call. Pass
   * null to detach.
   */
  setAuthEventHandler,

  consent,
  auth,
  attribution,
  whatsapp,

  /**
   * Tear the SDK back down to its pre-`init()` state: auth state machine
   * reset, WebOTP disarmed, token cache dropped, event handler detached,
   * configuration cleared. `init()` must be called again afterwards.
   *
   * This is the whole-SDK reset. To end a login attempt while staying
   * initialised — the common case, including sign-out — use
   * `QuickAuth.auth.reset({ forgetDevice: true })`.
   */
  reset(): void {
    resetAuth()
    setAuthEventHandler(null)
    __resetTokenManager()
    __resetConfig()
  },

  /** Error class thrown for non-2xx API responses. Reachable from the script-tag build. */
  QuickAuthError,

  /** @deprecated Use {@link QuickAuth.isInitialized}. */
  isConfigured,

  /** @deprecated Promoted to the facade: `tokenManager`, `setAuthEventHandler`. */
  _internal: { storage, flushQueue, tokenManager, setAuthEventHandler },
}
