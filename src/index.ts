/**
 * @quickauth/web — phone OTP authentication + WhatsApp marketing attribution.
 *
 *   import { QuickAuth } from '@quickauth/web'
 *
 *   QuickAuth.init({
 *     onTokenExpiry: async () =>
 *       (await fetch('/api/quickauth-token').then(r => r.json())).sessionToken,
 *   })
 *
 * The `onTokenExpiry` callback must return a fresh `sessionToken` (a
 * short-lived JWT minted by your backend via `POST /v1/sdk/session` with
 * your `X-Client-Id` + `X-Client-Secret`). The SDK auto-refreshes the
 * token ~30s before it expires, so the callback is invoked rarely.
 */

import { startOTP, verifyOTP } from './auth/otp'
import { startWhatsAppLogin } from './auth/whatsapp'
import { observeOTP } from './auth/webotp'
import {
  captureLaunch,
  clearAttribution,
  getStoredAttribution,
} from './attribution/capture'
import { trackConversion } from './attribution/track'
import { clearQueue, flushQueue, QuickAuthError } from './core/client'
import { configure, isConfigured } from './core/config'
import { consent as consentStore } from './core/consent'
import { storage } from './core/storage'
import { tokenManager, __resetTokenManager } from './core/token'
import type { InitOptions } from './types'

export type {
  AttributionResult,
  DeviceInfo,
  FingerprintEnvelope,
  InitOptions,
  ObserveOTPOptions,
  OTPChannel,
  OTPSession,
  StartOTPOptions,
  TrackConversionOptions,
  VerifyOTPOptions,
  VerifyOTPResult,
  WhatsAppLoginOptions,
} from './types'

export { QuickAuthError }

const consent = {
  get: (): boolean => consentStore.get(),
  set: (value: boolean): void => {
    const previous = consentStore.get()
    consentStore.set(value)
    if (!value && previous) {
      // Revocation — wipe everything we have queued or remembered locally.
      clearQueue()
      clearAttribution()
    }
    if (value && !previous) {
      // Grant — flush any queued tracking events. Fire-and-forget.
      void flushQueue()
    }
  },
  onChange: consentStore.onChange,
}

const auth = {
  startOTP,
  verifyOTP,
  observeOTP,
  startWhatsAppLogin,
}

const attribution = {
  captureLaunch,
  trackConversion,
  getStored: getStoredAttribution,
}

export const QuickAuth = {
  version: '0.1.0',
  /**
   * Initialise the SDK.
   *
   * Provide ONE of:
   *  - `onTokenExpiry`: an async callback that returns a fresh sessionToken
   *    minted by your backend (RECOMMENDED — production-safe).
   *  - `unsafe.directClientId` + `unsafe.directClientSecret`: trusted-
   *    deployment-only escape hatch. Embeds your client_secret in the
   *    bundle. Logs a console warning. NOT recommended.
   *
   * Optionally pass `initialToken` if you already have a fresh sessionToken
   * at init time (skips the first `onTokenExpiry` call).
   */
  init(options: InitOptions): void {
    configure(options)
    // Reset token cache so each init() starts cold.
    __resetTokenManager()
    consentStore.hydrate(options.consent)
    if (consentStore.get()) {
      // Replay any pending events from a previous session.
      void flushQueue()
    }
  },
  isConfigured,
  consent,
  auth,
  attribution,
  // Escape hatch for advanced use-cases (testing, custom UIs).
  _internal: { storage, flushQueue, tokenManager },
}
