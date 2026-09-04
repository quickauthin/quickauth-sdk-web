/**
 * WebOTP hub — one credential request, many subscribers.
 *
 * `navigator.credentials.get({ otp })` is single-shot: it resolves once with
 * the code and is then spent, and a browser will only honour one outstanding
 * OTP request at a time. That drives the whole shape of this module:
 *
 * - There is exactly ONE in-flight request, owned here, and every consumer
 *   (the auth state machine's own arming, plus any number of `observeOTP`
 *   callers) is a listener on it. Letting `initiate()` and `observeOTP()` each
 *   call `credentials.get` raced two requests against each other, and the
 *   browser cancelled the first — so whichever consumer armed earlier silently
 *   never fired.
 * - Arming again ({@link armWebOtp}) tears the previous request down first.
 *   A resend or a second `initiate()` must start a fresh request, because the
 *   previous one may already be spent, and two live ones cannot coexist.
 * - Delivery is fanned out from {@link deliverCode} only. The `OTP_AUTO_READ`
 *   event is emitted by the auth state machine's listener, NOT here — when
 *   this module also emitted, a caller who used `observeOTP` while the state
 *   machine was armed saw the event twice for one code, which flickers a
 *   merchant's OTP field (filled, cleared, filled).
 */

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

interface Listener {
  onCode: (code: string) => void
  onError?: (err: unknown) => void
}

const listeners = new Set<Listener>()

/** The live credential request, or null when nothing is armed / it is spent. */
let controller: AbortController | null = null

/** Whether this browser can actually auto-read SMS (Chromium on Android). */
export function isWebOTPSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'OTPCredential' in window &&
    typeof navigator !== 'undefined' &&
    !!(navigator as { credentials?: CredentialsContainerLike }).credentials
  )
}

/**
 * Register a code listener. Returns a disposer.
 *
 * The disposer only removes this listener; it tears the shared request down
 * only when nothing is left listening, so one caller disposing cannot disarm
 * auto-read for the login flow that is still running.
 */
export function addListener(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) disarmWebOTP()
  }
}

/** Fan a code out to every listener. Handler failures are contained. */
export function deliverCode(code: string): void {
  // Snapshot: a listener may dispose itself (or another) while being called.
  for (const listener of Array.from(listeners)) {
    if (!listeners.has(listener)) continue
    try {
      listener.onCode(code)
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.error('[QuickAuth] auto-read listener threw:', err)
      }
    }
  }
}

/**
 * Start (or restart) the WebOTP request. No-op on browsers without WebOTP —
 * those callers still get `autocomplete="one-time-code"` from `observeOTP`,
 * which is what iOS QuickType and most Android keyboards use.
 */
export function armWebOTP(): void {
  if (!isWebOTPSupported()) return

  // Drop the previous request first: it may be spent, and browsers allow only
  // one outstanding OTP request.
  disarmWebOTP()

  const mine = new AbortController()
  controller = mine

  const creds = (navigator as unknown as { credentials: CredentialsContainerLike })
    .credentials

  creds
    .get({ otp: { transport: ['sms'] }, signal: mine.signal })
    .then((cred) => {
      // Superseded by a newer arm (or a disarm) — the code belongs to an
      // attempt that no longer exists, so dropping it is the correct outcome.
      if (controller !== mine) return
      controller = null // single-shot: this request is now spent
      if (cred && typeof cred.code === 'string' && cred.code) {
        deliverCode(cred.code)
      }
    })
    .catch((err) => {
      // An abort we caused is not an error anyone needs to hear about.
      if (controller !== mine) return
      controller = null
      for (const listener of Array.from(listeners)) {
        try {
          listener.onError?.(err)
        } catch {
          // A listener's error handler must not mask the original failure.
        }
      }
    })
}

/** Abort the live request, if any. Safe to call repeatedly. */
export function disarmWebOTP(): void {
  const live = controller
  controller = null
  live?.abort()
}

/**
 * Observe inbound SMS one-time codes.
 *
 * On browsers without WebOTP (iOS Safari, Firefox) this still stamps
 * `autocomplete="one-time-code"` / `inputmode="numeric"` on the input so the
 * platform keyboard can offer the code, and the returned disposer is a no-op
 * beyond deregistering.
 *
 * Callers do NOT have to use this to get auto-read: `initiate()` arms WebOTP
 * itself and reports codes as `OTP_AUTO_READ` events. Use this when you want
 * the code in a callback (or the input auto-filled) as well.
 */
export function observeOTP(opts: ObserveOTPOptions): () => void {
  if (!opts || typeof opts.onCode !== 'function') {
    throw new Error('[QuickAuth] observeOTP requires { onCode }')
  }

  const input = resolveInput(opts.input)
  if (input) {
    input.setAttribute('autocomplete', 'one-time-code')
    input.setAttribute('inputmode', 'numeric')
  }

  const remove = addListener({
    onCode: (code) => {
      if (input) input.value = code
      opts.onCode(code)
    },
    onError: opts.onError,
  })

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    remove()
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      dispose()
      return dispose
    }
    opts.signal.addEventListener('abort', dispose, { once: true })
  }

  armWebOTP()
  return dispose
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

/** Test-only — drops every listener and the live request. */
export function __resetWebOTP(): void {
  listeners.clear()
  disarmWebOTP()
}
