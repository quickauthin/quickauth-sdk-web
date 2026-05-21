import { vi } from 'vitest'
import { QuickAuth } from '../src/index'
import { __resetConfig } from '../src/core/config'
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
  storage.purge()
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
}): void {
  QuickAuth.init({
    apiBaseUrl: 'https://api.test.local',
    consent: opts.consent ?? true,
    fetch: opts.fetch,
    maxRetries: 0,
    initialToken: opts.initialToken ?? fakeJwt(600),
    onTokenExpiry: opts.onTokenExpiry ?? (async () => fakeJwt(600)),
  })
}
