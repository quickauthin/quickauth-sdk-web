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
 *   await QuickAuth.auth.initiate({ phone: '+919876543210' })
 *   // ...wait for OTP_SENT event, collect code from user...
 *   await QuickAuth.auth.submitOtp('123456')
 *
 *   // On user-initiated sign-out:
 *   QuickAuth.auth.reset({ forgetDevice: true })
 *
 * The `onTokenExpiry` callback must return a fresh `sessionToken` (a
 * short-lived JWT minted by your backend via `POST /v1/sdk/session` with
 * your `X-Client-Id` + `X-Client-Secret`). The SDK auto-refreshes the
 * token ~30s before it expires, so the callback is invoked rarely.
 */

import { initiate, resendOtp, reset, submitOtp } from './auth/session'
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
import { setAuthEventHandler } from './core/events'
import { storage } from './core/storage'
import { tokenManager, __resetTokenManager } from './core/token'
import type { InitOptions } from './types'

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
  reset,
  observeOTP,
  startWhatsAppLogin,
}

const attribution = {
  captureLaunch,
  trackConversion,
  getStored: getStoredAttribution,
}

export const QuickAuth = {
  version: '1.1.0',
  init(options: InitOptions): void {
    configure(options)
    __resetTokenManager()
    consentStore.hydrate(options.consent)
    if (consentStore.get()) {
      void flushQueue()
    }
  },
  isConfigured,
  consent,
  auth,
  attribution,
  _internal: { storage, flushQueue, tokenManager, setAuthEventHandler },
}
