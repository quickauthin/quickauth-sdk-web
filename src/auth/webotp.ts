import { emitAuthEvent } from '../core/events'
import type { ObserveOTPOptions } from '../types'

interface OTPCredentialLike {
  code: string
}

interface CredentialsContainerLike {
  get(req: {
    otp: { transport: string[] }
    signal?: AbortSignal
  }): Promise<OTPCredentialLike | null>
}

/**
 * Observe inbound SMS one-time codes via the WebOTP API. On unsupported browsers
 * (iOS Safari, Firefox), we still stamp `autocomplete="one-time-code"` so the
 * platform keyboard / iOS QuickType can offer the code.
 */
export function observeOTP(opts: ObserveOTPOptions): () => void {
  if (!opts || typeof opts.onCode !== 'function') {
    throw new Error('[QuickAuth] observeOTP requires { onCode }')
  }

  // Always stamp autocomplete on the input we know about — improves iOS UX.
  const input = resolveInput(opts.input)
  if (input) {
    input.setAttribute('autocomplete', 'one-time-code')
    input.setAttribute('inputmode', 'numeric')
  }

  const supported =
    typeof window !== 'undefined' &&
    'OTPCredential' in window &&
    typeof navigator !== 'undefined' &&
    !!(navigator as { credentials?: CredentialsContainerLike }).credentials

  if (!supported) {
    // Nothing else to wire up — return a no-op disposer.
    return () => undefined
  }

  const ac = new AbortController()
  // Compose with caller's signal if provided.
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true })
  }

  const creds = (
    navigator as unknown as { credentials: CredentialsContainerLike }
  ).credentials

  creds
    .get({ otp: { transport: ['sms'] }, signal: ac.signal })
    .then((cred) => {
      if (cred && typeof cred.code === 'string') {
        if (input) input.value = cred.code
        opts.onCode(cred.code)
        // Also surface to the headless auth event stream so merchants who
        // only subscribe to onAuthEvent can pick up auto-read codes.
        emitAuthEvent({ type: 'OTP_AUTO_READ', code: cred.code })
      }
    })
    .catch((err) => {
      if (opts.onError) opts.onError(err)
    })

  return () => ac.abort()
}

function resolveInput(
  ref: ObserveOTPOptions['input'],
): HTMLInputElement | null {
  if (!ref) return null
  if (typeof ref === 'string') {
    if (typeof document === 'undefined') return null
    return document.querySelector<HTMLInputElement>(ref)
  }
  return ref
}
