import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickAuth, QuickAuthError } from '../src/index'
import type { AuthEvent } from '../src/types'
import { fakeJwt, flush, resetSdk } from './_helpers'

const PHONE = '+919876543210'
const OTP_SENT = { state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 }

type Reply = () => Response

function fetchOf(...replies: Reply[]) {
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const next = replies.shift()
    if (!next) throw new Error('no reply scripted')
    return next()
  })
}

const json = (body: unknown, status = 200): Reply => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const raw = (text: string, type: string, status = 200): Reply => () =>
  new Response(text, { status, headers: { 'Content-Type': type, 'X-Request-Id': 'rid_portal' } })

/** Headers arrive, then the body never finishes. */
const stalled = (): Reply => () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"state":'))
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

/** Headers arrive, then the connection drops mid-body. */
const dropped = (): Reply => () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"state":'))
        c.error(new TypeError('network connection was lost'))
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

function setup(fetch: ReturnType<typeof fetchOf>, extra: Record<string, unknown> = {}) {
  const events: AuthEvent[] = []
  QuickAuth.init({
    publishableKey: 'pk_test_x',
    apiBaseUrl: 'https://api.test.local',
    fetch: fetch as unknown as typeof globalThis.fetch,
    maxRetries: 0,
    onAuthEvent: (e) => events.push(e),
    ...extra,
  })
  return events
}

const errorOf = (events: AuthEvent[]) => events.find((e) => e.type === 'ERROR') as Extract<AuthEvent, { type: 'ERROR' }>

beforeEach(() => resetSdk())

describe('2xx responses the SDK cannot use → SERVER_ERROR / INVALID_RESPONSE', () => {
  it('HTML login page (public Wi-Fi) on initiate: no OTP_SENT, readable error, not retried', async () => {
    const fetch = fetchOf(raw('<html>Sign in to Wi-Fi</html>', 'text/html; charset=utf-8'))
    const events = setup(fetch, { maxRetries: 3 })

    const err = await QuickAuth.auth.initiate({ phone: PHONE }).catch((e) => e)
    await flush()

    expect(err).toBeInstanceOf(QuickAuthError)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(events.map((e) => e.type)).toEqual(['ERROR'])
    expect(errorOf(events)).toMatchObject({
      code: 'SERVER_ERROR',
      errorCode: 'INVALID_RESPONSE',
      status: 200,
      requestId: 'rid_portal',
    })
    expect(errorOf(events).message).toMatch(/Unexpected response from the server \(HTTP 200, text\/html\)/)
    expect(errorOf(events).message).toMatch(/apiBaseUrl|login page/)
    await expect(QuickAuth.auth.submitOtp('123456')).rejects.toThrow(/state "failed"/)
  })

  it.each([
    ['empty body', () => new Response('', { status: 200 })],
    ['JSON without sessionId', json({ state: 'OTP_SENT', expiresIn: 300 })],
    ['JSON with an empty sessionId', json({ state: 'OTP_SENT', sessionId: '' })],
    ['JSON array', json([])],
  ])('initiate %s → missing sessionId', async (_name, reply) => {
    const events = setup(fetchOf(reply))
    await QuickAuth.auth.initiate({ phone: PHONE }).catch(() => undefined)
    await flush()
    expect(events.map((e) => e.type)).toEqual(['ERROR'])
    expect(errorOf(events)).toMatchObject({ code: 'SERVER_ERROR', errorCode: 'INVALID_RESPONSE', status: 200 })
    expect(errorOf(events).message).toBe('[QuickAuth] Invalid response from /v1/sdk/auth/initiate: missing sessionId')
  })

  it.each([
    ['{}', {}],
    ['VERIFIED without requestId', { state: 'VERIFIED', verified: true }],
    ['legacy verified:true without requestId', { verified: true }],
  ])('verify %s → missing state/requestId', async (_name, body) => {
    const events = setup(fetchOf(json(OTP_SENT), json(body)))
    await QuickAuth.auth.initiate({ phone: PHONE })
    await QuickAuth.auth.submitOtp('123456').catch(() => undefined)
    await flush()
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'ERROR'])
    expect(errorOf(events)).toMatchObject({ code: 'SERVER_ERROR', errorCode: 'INVALID_RESPONSE', status: 200 })
    expect(errorOf(events).message).toBe('[QuickAuth] Invalid response from /v1/sdk/auth/verify: missing state/requestId')
  })

  it('verify HTML page → not-the-API error', async () => {
    const events = setup(fetchOf(json(OTP_SENT), raw('<html/>', 'text/html')))
    await QuickAuth.auth.initiate({ phone: PHONE })
    await QuickAuth.auth.submitOtp('123456').catch(() => undefined)
    await flush()
    expect(errorOf(events).message).toMatch(/HTTP 200, text\/html\) for \/v1\/sdk\/auth\/verify/)
  })

  it('still accepts every valid shape', async () => {
    const events = setup(
      fetchOf(
        json(OTP_SENT),
        json({ verified: false, message: 'nope' }),
        json({ state: 'OTP_FAILED', requestId: 'r' }),
        json({ state: 'VERIFIED', requestId: 'req_ok', message: 'ok' }),
      ),
    )
    await QuickAuth.auth.initiate({ phone: PHONE })
    await QuickAuth.auth.submitOtp('111111')
    await QuickAuth.auth.submitOtp('222222')
    await QuickAuth.auth.submitOtp('333333')
    await flush()
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_FAILED', 'OTP_FAILED', 'VERIFIED'])
    expect(events[2]).toEqual({ type: 'OTP_FAILED', message: 'Incorrect code' })
  })

  it('initiate answering VERIFIED (OneTap) needs only sessionId', async () => {
    const events = setup(fetchOf(json({ state: 'VERIFIED', sessionId: 'req_onetap' })))
    await QuickAuth.auth.initiate({ phone: PHONE })
    await flush()
    expect(events).toEqual([{ type: 'VERIFIED', requestId: 'req_onetap' }])
  })

  it('an empty 200 is still fine where no body is expected (conversion)', async () => {
    const fetch = fetchOf(() => new Response('', { status: 200 }))
    setup(fetch, { consent: true })
    await expect(QuickAuth.attribution.trackConversion({ event: 'signup' })).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('timeout covers the response body', () => {
  it('headers then a stalled body → TIMEOUT "mid-response"', async () => {
    const events = setup(fetchOf(stalled()), { requestTimeoutMs: 50 })
    const t0 = Date.now()
    const err = await QuickAuth.auth.initiate({ phone: PHONE }).catch((e) => e)
    await flush()
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(err).toMatchObject({ code: 'TIMEOUT', status: 200 })
    expect(errorOf(events)).toMatchObject({ code: 'TIMEOUT', status: 200 })
    expect(errorOf(events).message).toBe(
      '[QuickAuth] Request timed out after 0.05s — the server stopped responding mid-response',
    )
  })

  it('a stalled body is retried like any timeout, with the same Idempotency-Key', async () => {
    const fetch = fetchOf(stalled(), json(OTP_SENT))
    const events = setup(fetch, { requestTimeoutMs: 50, maxRetries: 1 })
    await QuickAuth.auth.initiate({ phone: PHONE })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    const keys = fetch.mock.calls.map((c) => (c[1].headers as Record<string, string>)['Idempotency-Key'])
    expect(keys[0]).toBe(keys[1])
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT'])
  })

  it('connection dropped mid-body → NETWORK_ERROR, not an empty success', async () => {
    const events = setup(fetchOf(dropped()))
    await QuickAuth.auth.initiate({ phone: PHONE }).catch(() => undefined)
    await flush()
    expect(events.map((e) => e.type)).toEqual(['ERROR'])
    expect(errorOf(events)).toMatchObject({ code: 'NETWORK_ERROR', status: 200 })
    expect(errorOf(events).message).toMatch(/connection dropped while reading the response/)
  })

  it('a slow but complete response within the timeout still succeeds', async () => {
    const slow: Reply = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"state":"OTP_SENT",'))
            setTimeout(() => {
              c.enqueue(new TextEncoder().encode('"sessionId":"s_slow"}'))
              c.close()
            }, 30)
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    const events = setup(fetchOf(slow), { requestTimeoutMs: 1000 })
    await QuickAuth.auth.initiate({ phone: PHONE })
    await flush()
    expect(events[0]).toMatchObject({ type: 'OTP_SENT', sessionId: 's_slow' })
  })

  it('unsafe-mode token mint with a stalled body → TOKEN_ERROR mentioning the timeout', async () => {
    const events: AuthEvent[] = []
    QuickAuth.init({
      unsafe: { directClientId: 'cid', directClientSecret: 'sec' },
      silent: true,
      apiBaseUrl: 'https://api.test.local',
      fetch: fetchOf(stalled()) as unknown as typeof globalThis.fetch,
      maxRetries: 0,
      requestTimeoutMs: 50,
      onAuthEvent: (e) => events.push(e),
    })
    await QuickAuth.auth.initiate({ phone: PHONE }).catch(() => undefined)
    await flush()
    expect(errorOf(events).code).toBe('TOKEN_ERROR')
    expect(errorOf(events).message).toMatch(/timed out after 0\.05s — the server stopped responding mid-response/)
  })

  it('the 401 refresh path still works with the new body handling', async () => {
    let mints = 0
    const fetch = fetchOf(json({ message: 'expired' }, 401), json(OTP_SENT))
    const events: AuthEvent[] = []
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxRetries: 0,
      onTokenExpiry: async () => (mints++, fakeJwt(600)),
      onAuthEvent: (e) => events.push(e),
    })
    await QuickAuth.auth.initiate({ phone: PHONE })
    await flush()
    expect(mints).toBe(2)
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT'])
  })
})
