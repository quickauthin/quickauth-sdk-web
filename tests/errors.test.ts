import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickAuth, QuickAuthError, type AuthEvent } from '../src/index'
import { fakeJwt, flush, resetSdk } from './_helpers'

type ErrorEvent = Extract<AuthEvent, { type: 'ERROR' }>

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, extra: Record<string, unknown> = {}) {
  const events: AuthEvent[] = []
  const fn = vi.fn(fetchImpl)
  QuickAuth.init({
    apiBaseUrl: 'https://api.test.local',
    initialToken: fakeJwt(600),
    fetch: fn as unknown as typeof fetch,
    maxRetries: 0,
    onAuthEvent: (e) => events.push(e),
    ...extra,
  })
  return { fn, events, lastError: () => events.filter((e): e is ErrorEvent => e.type === 'ERROR').at(-1) }
}

describe('ERROR events carry the server reason', () => {
  beforeEach(() => resetSdk())

  it('server message, errorCode, status and requestId', async () => {
    const { events, lastError } = setup(async () =>
      reply(400, { errorCode: 'INVALID_REQUEST', message: 'phone: phone is required', requestId: 'req_123' }),
    )
    const err = await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch((e) => e)
    await flush()

    expect(err).toBeInstanceOf(QuickAuthError)
    expect(err).toMatchObject({ code: 'CLIENT_ERROR', status: 400, errorCode: 'INVALID_REQUEST', requestId: 'req_123' })
    expect(lastError()).toEqual({
      type: 'ERROR',
      code: 'CLIENT_ERROR',
      message: '[QuickAuth] HTTP 400: phone: phone is required',
      errorCode: 'INVALID_REQUEST',
      status: 400,
      requestId: 'req_123',
    })
    expect(events).toHaveLength(1)
  })

  it('429 → RATE_LIMITED with retryAfter from the Retry-After header', async () => {
    const { lastError } = setup(async () => reply(429, { errorCode: 'RATE_LIMITED', message: 'slow down' }, { 'Retry-After': '120' }))
    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)
    await flush()
    expect(lastError()).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfter: 120 })
  })

  it('429 → retryAfter from the response body when the header is not exposed', async () => {
    const { lastError } = setup(async () => reply(429, { message: 'slow down', retryAfterSeconds: 45 }))
    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)
    await flush()
    expect(lastError()?.retryAfter).toBe(45)
  })

  it('5xx after retries → SERVER_ERROR with the server message', async () => {
    const { fn, lastError } = setup(async () => reply(503, { message: 'maintenance' }), { maxRetries: 1 })
    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)
    await flush()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(lastError()).toMatchObject({ code: 'SERVER_ERROR', status: 503, message: '[QuickAuth] HTTP 503: maintenance' })
  })
})

describe('transport failures', () => {
  beforeEach(() => resetSdk())

  it('fetch rejection → NETWORK_ERROR, retried up to maxRetries', async () => {
    const { fn, lastError } = setup(
      async () => {
        throw new TypeError('Failed to fetch')
      },
      { maxRetries: 2 },
    )
    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)
    await flush()
    expect(fn).toHaveBeenCalledTimes(3)
    expect(lastError()?.code).toBe('NETWORK_ERROR')
    expect(lastError()?.message).toMatch(/Failed to fetch/)
    expect(lastError()?.message).toMatch(/CORS/)
  })

  it('no response within requestTimeoutMs → TIMEOUT', async () => {
    const { lastError } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
      { requestTimeoutMs: 30 },
    )
    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)
    await flush()
    expect(lastError()).toMatchObject({ code: 'TIMEOUT', message: '[QuickAuth] Request timed out after 0.03s' })
  })

  it('requestTimeoutMs defaults to 15000', () => {
    setup(async () => reply(200, {}))
    expect(QuickAuth.config.requestTimeoutMs).toBe(15000)
  })
})

describe('token failures', () => {
  beforeEach(() => resetSdk())

  it('onTokenExpiry throwing → TOKEN_ERROR, no API call, no retries', async () => {
    const events: AuthEvent[] = []
    const fn = vi.fn(async () => reply(200, {}))
    const onTokenExpiry = vi.fn(async () => {
      throw new Error('backend down')
    })
    QuickAuth.init({ apiBaseUrl: 'https://api.test.local', onTokenExpiry, fetch: fn as unknown as typeof fetch, maxRetries: 3, onAuthEvent: (e) => events.push(e) })
    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)
    await flush()
    expect(fn).not.toHaveBeenCalled()
    expect(onTokenExpiry).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: 'ERROR', code: 'TOKEN_ERROR', message: '[QuickAuth] Could not get a session token: backend down' })
  })

  it('unsafe mint rejected → TOKEN_ERROR keeping the server status and errorCode', async () => {
    const events: AuthEvent[] = []
    const fn = vi.fn(async () => reply(401, { errorCode: 'INVALID_CLIENT_CREDENTIALS', message: 'bad secret' }))
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      unsafe: { directClientId: 'qc_x', directClientSecret: 'nope' },
      fetch: fn as unknown as typeof fetch,
      silent: true,
      onAuthEvent: (e) => events.push(e),
    })
    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)
    await flush()
    expect(events.at(-1)).toMatchObject({
      type: 'ERROR',
      code: 'TOKEN_ERROR',
      status: 401,
      errorCode: 'INVALID_CLIENT_CREDENTIALS',
      message: '[QuickAuth] Could not get a session token: HTTP 401: bad secret',
    })
  })
})

describe('response fallbacks (parity with RN / Flutter)', () => {
  beforeEach(() => resetSdk())

  it('OTP_SENT.expiresIn defaults to 300 when the server omits it', async () => {
    const { events } = setup(async () => reply(200, { state: 'OTP_SENT', sessionId: 's1' }))
    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await flush()
    expect(events[0]).toMatchObject({ type: 'OTP_SENT', expiresIn: 300 })
  })

  it('verify answering { verified: true } without state → VERIFIED', async () => {
    const { events } = setup(async (url) =>
      url.endsWith('/initiate') ? reply(200, { state: 'OTP_SENT', sessionId: 's1', expiresIn: 60 }) : reply(200, { verified: true, requestId: 'req_9', message: 'ok' }),
    )
    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.submitOtp('123456')
    await flush()
    expect(events.at(-1)).toEqual({ type: 'VERIFIED', requestId: 'req_9', message: 'ok' })
  })

  it('an explicit state still wins over a stray verified flag', async () => {
    const { events } = setup(async (url) =>
      url.endsWith('/initiate') ? reply(200, { state: 'OTP_SENT', sessionId: 's1', expiresIn: 60 }) : reply(200, { state: 'OTP_FAILED', verified: true, message: 'wrong' }),
    )
    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.submitOtp('123456')
    await flush()
    expect(events.at(-1)).toEqual({ type: 'OTP_FAILED', message: 'wrong' })
  })
})

describe('debug and silent', () => {
  let log: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    resetSdk()
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  const flow = async (url: string) =>
    url.endsWith('/initiate')
      ? reply(200, { state: 'OTP_SENT', sessionId: 's1', expiresIn: 60, deviceToken: 'dtok_secret' })
      : reply(200, { state: 'VERIFIED', requestId: 'req_1' })

  it('debug: true logs requests, responses and events with secrets masked', async () => {
    setup(flow, { debug: true })
    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.submitOtp('482913')
    await flush()

    const lines = log.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    expect(lines.every((l) => l.startsWith('[QuickAuth]'))).toBe(true)
    expect(lines.some((l) => l.includes('→ POST /v1/sdk/auth/initiate'))).toBe(true)
    expect(lines.some((l) => l.includes('← 200 POST /v1/sdk/auth/verify'))).toBe(true)
    expect(lines.some((l) => l.includes('event OTP_SENT'))).toBe(true)
    expect(lines.some((l) => l.includes('event VERIFIED'))).toBe(true)
    const all = lines.join('\n')
    expect(all).not.toContain('482913')
    expect(all).not.toContain('dtok_secret')
  })

  it('debug off (default) logs nothing', async () => {
    setup(flow)
    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await flush()
    expect(log).not.toHaveBeenCalled()
  })

  it('silent: true suppresses the UNSAFE warning and handler errors', async () => {
    QuickAuth.init({
      unsafe: { directClientId: 'qc_x', directClientSecret: 'y' },
      fetch: (async () => reply(200, {})) as unknown as typeof fetch,
      silent: true,
      onAuthEvent: () => {
        throw new Error('merchant bug')
      },
    })
    QuickAuth.auth.publishAutoReadCode('123456')
    await flush()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('without silent, the UNSAFE warning and handler errors are reported', async () => {
    QuickAuth.init({
      unsafe: { directClientId: 'qc_x', directClientSecret: 'y' },
      fetch: (async () => reply(200, {})) as unknown as typeof fetch,
      onAuthEvent: () => {
        throw new Error('merchant bug')
      },
    })
    QuickAuth.auth.publishAutoReadCode('123456')
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/UNSAFE/))
    expect(error).toHaveBeenCalledWith('[QuickAuth]', 'onAuthEvent handler threw:', expect.any(Error))
  })
})
