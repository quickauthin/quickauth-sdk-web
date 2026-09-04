import { vi } from 'vitest'
import { QuickAuth } from '../src/index'
import { __resetSession } from '../src/auth/session'
import { __resetWebOTP } from '../src/auth/webotp'
import { __resetConfig } from '../src/core/config'
import { __resetAuthEvents } from '../src/core/events'
import { storage } from '../src/core/storage'
import { __resetTokenManager } from '../src/core/token'

/**
 * Build a JWT-shaped string with a custom `exp` (seconds). The signature
 * segment is intentionally fake — the SDK never verifies it (server's job).
 */
export function fakeJwt(expSecondsFromNow = 600): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  return `${enc(header)}.${enc(payload)}.sig`
}

export interface MockFetch {
  fn: ReturnType<typeof vi.fn>
  reply: (body: unknown, init?: { status?: number; ok?: boolean }) => void
  failOnce: (status: number) => void
}

export function makeMockFetch(): MockFetch {
  const responses: Array<() => Response> = []
  const fn = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift()
    if (next) return next()
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return {
    fn,
    reply(body, init = {}) {
      responses.push(
        () =>
          new Response(JSON.stringify(body), {
            status: init.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      )
    },
    failOnce(status) {
      responses.push(
        () =>
          new Response(JSON.stringify({ error: 'fail' }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
      )
    },
  }
}

export function resetSdk(): void {
  __resetConfig()
  __resetTokenManager()
  __resetAuthEvents()
  __resetSession()
  __resetWebOTP()
  storage.purge()
}

/** Let queued microtasks and already-resolved promises run to completion. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

interface WebOTPRequest {
  signal?: AbortSignal
  aborted: boolean
  /** Deliver a code, as the browser would when the SMS arrives. */
  deliver: (code: string) => void
}

export interface WebOTPMock {
  /** Every `navigator.credentials.get({ otp })` call, oldest first. */
  requests: WebOTPRequest[]
  /** Requests that are still live (not aborted). */
  live: () => WebOTPRequest[]
  restore: () => void
}

/**
 * Stand in for the WebOTP API. `navigator.credentials.get` returns a promise
 * the test resolves by hand, so we can assert on arming, tear-down and
 * ordering rather than waiting for a real SMS.
 */
export function mockWebOTP(): WebOTPMock {
  const originalCreds = Object.getOwnPropertyDescriptor(navigator, 'credentials')
  const hadOTPCredential = 'OTPCredential' in window
  const originalOTPCredential = (window as unknown as { OTPCredential?: unknown })
    .OTPCredential

  Object.defineProperty(window, 'OTPCredential', {
    value: function OTPCredential() {},
    configurable: true,
    writable: true,
  })

  const requests: WebOTPRequest[] = []
  const get = vi.fn(
    (req: { otp: { transport: string[] }; signal?: AbortSignal }) =>
      new Promise<{ code: string } | null>((resolve, reject) => {
        const entry: WebOTPRequest = {
          signal: req.signal,
          aborted: false,
          deliver: (code: string) => resolve({ code }),
        }
        requests.push(entry)
        req.signal?.addEventListener('abort', () => {
          entry.aborted = true
          reject(new Error('AbortError'))
        })
      }),
  )

  Object.defineProperty(navigator, 'credentials', {
    value: { get },
    configurable: true,
  })

  return {
    requests,
    live: () => requests.filter((r) => !r.aborted),
    restore(): void {
      if (originalCreds) {
        Object.defineProperty(navigator, 'credentials', originalCreds)
      } else {
        delete (navigator as unknown as { credentials?: unknown }).credentials
      }
      if (hadOTPCredential) {
        ;(window as unknown as { OTPCredential?: unknown }).OTPCredential =
          originalOTPCredential
      } else {
        delete (window as unknown as { OTPCredential?: unknown }).OTPCredential
      }
    },
  }
}

export function setUrl(href: string): void {
  const w = window as unknown as {
    happyDOM?: { setURL?: (u: string) => void }
  }
  if (w.happyDOM?.setURL) {
    w.happyDOM.setURL(href)
  } else {
    window.history.replaceState({}, '', href)
  }
}

export function initSdk(opts: {
  fetch: typeof fetch
  consent?: boolean
  initialToken?: string
  onTokenExpiry?: () => Promise<string>
  onAuthEvent?: (event: unknown) => void
}): void {
  QuickAuth.init({
    apiBaseUrl: 'https://api.test.local',
    consent: opts.consent ?? true,
    fetch: opts.fetch,
    maxRetries: 0,
    initialToken: opts.initialToken ?? fakeJwt(600),
    onTokenExpiry: opts.onTokenExpiry ?? (async () => fakeJwt(600)),
    onAuthEvent: opts.onAuthEvent as never,
  })
}
