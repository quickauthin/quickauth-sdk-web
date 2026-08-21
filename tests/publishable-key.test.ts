import { beforeEach, describe, expect, it } from 'vitest'
import { QuickAuth } from '../src/index'
import { __classifyError } from '../src/auth/session'
import { QuickAuthError } from '../src/core/client'
import type { AuthEvent } from '../src/types'
import { fakeJwt, makeMockFetch, resetSdk } from './_helpers'

const flushEvents = (): Promise<void> => Promise.resolve()

function headersOf(mock: ReturnType<typeof makeMockFetch>, call = 0): Record<string, string> {
  return (mock.fn.mock.calls[call]![1] as RequestInit).headers as Record<
    string,
    string
  >
}

describe('QuickAuth.init — auth mode selection', () => {
  beforeEach(resetSdk)

  it('accepts publishableKey alone', () => {
    expect(() =>
      QuickAuth.init({ publishableKey: 'pk_test_123' }),
    ).not.toThrow()
  })

  it('rejects neither mode', () => {
    expect(() => QuickAuth.init({})).toThrow(
      /publishableKey.*onTokenExpiry|onTokenExpiry.*publishableKey/,
    )
  })

  it('rejects both modes together', () => {
    expect(() =>
      QuickAuth.init({
        publishableKey: 'pk_test_123',
        onTokenExpiry: async () => fakeJwt(600),
      }),
    ).toThrow(/not both/i)
  })

  it('rejects publishableKey combined with a seeded initialToken', () => {
    expect(() =>
      QuickAuth.init({
        publishableKey: 'pk_test_123',
        initialToken: fakeJwt(600),
      }),
    ).toThrow(/not both/i)
  })

  it('treats an empty publishableKey as not supplied', () => {
    // Empty string is a common "env var missing" footgun — it must not
    // silently enable key mode with a blank credential.
    expect(() => QuickAuth.init({ publishableKey: '' })).toThrow(
      /onTokenExpiry/,
    )
  })
})

describe('publishable-key mode — request headers', () => {
  beforeEach(resetSdk)

  it('sends X-QuickAuth-Key and no Authorization header', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      publishableKey: 'pk_live_abc123',
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    const headers = headersOf(mock)
    expect(headers['X-QuickAuth-Key']).toBe('pk_live_abc123')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('never consults the token manager in key mode', async () => {
    // Key mode forbids any token source, so the token manager has nothing to
    // refresh from: if the request path asked it for a token, this would
    // reject with "no onTokenExpiry callback ... configured" instead of
    // completing. Reaching OTP_SENT is the proof that it was skipped.
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    const events: AuthEvent[] = []
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      publishableKey: 'pk_live_abc123',
      onAuthEvent: (e) => events.push(e),
    })

    await expect(
      QuickAuth.auth.initiate({ phone: '+919876543210' }),
    ).resolves.toBeUndefined()
    await flushEvents()

    expect(events.map((e) => e.type)).toEqual(['OTP_SENT'])
    expect(mock.fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry-with-refresh on 401 in key mode (the key itself was rejected)', async () => {
    const mock = makeMockFetch()
    mock.failOnce(401)
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      publishableKey: 'pk_live_abc123',
    })

    await expect(
      QuickAuth.auth.initiate({ phone: '+919876543210' }),
    ).rejects.toBeDefined()
    expect(mock.fn).toHaveBeenCalledTimes(1)
  })

  it('sends no app-identity header — the browser-set Origin is what the backend checks', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      publishableKey: 'pk_live_abc123',
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    const names = Object.keys(headersOf(mock)).map((h) => h.toLowerCase())
    expect(names).not.toContain('x-quickauth-package')
    expect(names).not.toContain('x-quickauth-bundle')
    expect(names).not.toContain('origin')
  })
})

describe('session-token mode — unchanged by the publishable-key work', () => {
  beforeEach(resetSdk)

  it('still sends Authorization: Bearer and no X-QuickAuth-Key', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    const token = fakeJwt(600)
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      initialToken: token,
      onTokenExpiry: async () => token,
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    const headers = headersOf(mock)
    expect(headers['Authorization']).toBe(`Bearer ${token}`)
    expect(headers['X-QuickAuth-Key']).toBeUndefined()
  })
})

describe('CORS-safe request headers', () => {
  beforeEach(resetSdk)

  // The backend's CORS config allows exactly: Authorization, Content-Type,
  // Idempotency-Key, X-Request-Id (plus X-QuickAuth-Key for key mode). Any
  // other request header fails the OPTIONS preflight and the call never
  // leaves the browser.
  const ALLOWED = new Set([
    'authorization',
    'content-type',
    'idempotency-key',
    'x-request-id',
    'x-quickauth-key',
  ])

  it('sends only preflight-allowlisted headers in session mode', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      initialToken: fakeJwt(600),
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    for (const name of Object.keys(headersOf(mock))) {
      expect(ALLOWED).toContain(name.toLowerCase())
    }
  })

  it('sends only preflight-allowlisted headers in publishable-key mode', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      publishableKey: 'pk_live_abc123',
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    for (const name of Object.keys(headersOf(mock))) {
      expect(ALLOWED).toContain(name.toLowerCase())
    }
  })

  it('reports the package version, not a stale hardcoded one', () => {
    expect(QuickAuth.version).toBe('1.1.0')
  })
})

describe('classifyError', () => {
  it('prefers the backend errorCode over the status bucket', () => {
    const err = new QuickAuthError('QuickAuth API 402', 402, {
      errorCode: 'INSUFFICIENT_BALANCE',
      message: 'Out of credits',
    })
    expect(__classifyError(err)).toBe('INSUFFICIENT_BALANCE')
  })

  it('maps a bare 402 to INSUFFICIENT_BALANCE', () => {
    expect(__classifyError(new QuickAuthError('nope', 402))).toBe(
      'INSUFFICIENT_BALANCE',
    )
  })

  it('keeps the existing status buckets', () => {
    expect(__classifyError(new QuickAuthError('x', 429))).toBe('RATE_LIMITED')
    expect(__classifyError(new QuickAuthError('x', 503))).toBe('SERVER_ERROR')
    expect(__classifyError(new QuickAuthError('x', 400))).toBe('CLIENT_ERROR')
    expect(__classifyError(new TypeError('offline'))).toBe('UNKNOWN_ERROR')
  })

  it('surfaces a non-402 errorCode too', () => {
    const err = new QuickAuthError('QuickAuth API 400', 400, {
      errorCode: 'INVALID_PHONE',
    })
    expect(__classifyError(err)).toBe('INVALID_PHONE')
  })

  it('ignores a non-string errorCode and falls back to the status bucket', () => {
    const err = new QuickAuthError('QuickAuth API 400', 400, { errorCode: 42 })
    expect(__classifyError(err)).toBe('CLIENT_ERROR')
  })
})

describe('ERROR events carry the backend error code end-to-end', () => {
  beforeEach(resetSdk)

  it('emits INSUFFICIENT_BALANCE when the API returns 402 + errorCode', async () => {
    const mock = makeMockFetch()
    mock.reply(
      { errorCode: 'INSUFFICIENT_BALANCE', message: 'Out of credits' },
      { status: 402 },
    )
    const events: AuthEvent[] = []
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: false,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      publishableKey: 'pk_live_abc123',
      onAuthEvent: (e) => events.push(e),
    })

    await expect(
      QuickAuth.auth.initiate({ phone: '+919876543210' }),
    ).rejects.toBeDefined()
    await flushEvents()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'ERROR',
      code: 'INSUFFICIENT_BALANCE',
    })
  })
})
