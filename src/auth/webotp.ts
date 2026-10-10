import { logger } from '../core/logger'
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

let controller: AbortController | null = null

export function isWebOTPSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'OTPCredential' in window &&
    typeof navigator !== 'undefined' &&
    !!(navigator as { credentials?: CredentialsContainerLike }).credentials
  )
}

export function addListener(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) disarmWebOTP()
  }
}

export function deliverCode(code: string): void {
  for (const listener of Array.from(listeners)) {
    if (!listeners.has(listener)) continue
    try {
      listener.onCode(code)
    } catch (err) {
      logger.error('auto-read listener threw:', err)
    }
  }
}

export function armWebOTP(): void {
  if (!isWebOTPSupported()) return

  // Keep a pending request rather than abort-and-reissue: Chrome on Android
  // shows the consent prompt for the aborted request and never settles the new one.
  if (controller) return

  const mine = new AbortController()
  controller = mine

  const creds = (navigator as unknown as { credentials: CredentialsContainerLike })
    .credentials

  creds
    .get({ otp: { transport: ['sms'] }, signal: mine.signal })
    .then((cred) => {
      if (controller !== mine) return
      controller = null
      if (cred && typeof cred.code === 'string' && cred.code) {
        deliverCode(cred.code)
      }
    })
    .catch((err) => {
      if (controller !== mine) return
      controller = null
      for (const listener of Array.from(listeners)) {
        try {
          listener.onError?.(err)
        } catch {
          // ignore
        }
      }
    })
}

export function disarmWebOTP(): void {
  const live = controller
  controller = null
  live?.abort()
}

/** Observe inbound SMS one-time codes. */
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

export function __resetWebOTP(): void {
  listeners.clear()
  disarmWebOTP()
}
