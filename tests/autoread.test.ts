import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickAuth } from '../src/index'
import type { AuthEvent } from '../src/types'
import {
  flush,
  initSdk,
  makeMockFetch,
  mockWebOTP,
  resetSdk,
  type WebOTPMock,
} from './_helpers'

const OTP_SENT = {
  state: 'OTP_SENT',
  sessionId: 'sess_1',
  expiresIn: 300,
  deviceToken: 'dtok',
}
const VERIFIED = {
  state: 'VERIFIED',
  verified: true,
  requestId: 'req_ok',
  message: 'Verified successfully',
}

describe('auto-read — initiate() arms WebOTP itself', () => {
  let web: WebOTPMock

  beforeEach(() => {
    resetSdk()
    web = mockWebOTP()
  })
  afterEach(() => web.restore())

  it('arms without the caller ever touching observeOTP', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    expect(web.requests).toHaveLength(1)

    web.requests[0]!.deliver('123456')
    await flush()

    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_AUTO_READ'])
    expect(events[1]).toEqual({ type: 'OTP_AUTO_READ', code: '123456' })
  })

  it('does not submit the auto-read code unless autoSubmit was asked for', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    web.requests[0]!.deliver('123456')
    await flush()

    // Only the /initiate call — nothing was verified on the user's behalf.
    expect(mock.fn).toHaveBeenCalledTimes(1)
  })

  it('submits the auto-read code when autoSubmit is on', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    mock.reply(VERIFIED)
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210', autoSubmit: true })
    web.requests[0]!.deliver('123456')
    await flush()

    const [url, init] = mock.fn.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://api.test.local/v1/sdk/auth/verify')
    expect(JSON.parse(init.body as string)).toMatchObject({
      sessionId: 'sess_1',
      code: '123456',
    })
    expect(events.map((e) => e.type)).toEqual([
      'OTP_SENT',
      'OTP_AUTO_READ',
      'VERIFIED',
    ])
  })

  it('auto-submits at most once per attempt (one-shot latch)', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    mock.reply(VERIFIED)
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210', autoSubmit: true })
    web.requests[0]!.deliver('123456')
    await flush()

    // The WhatsApp copy of the same message lands after the SMS one. Verifying
    // it would hit a code the server has already consumed, and the user would
    // see a failure arrive after they were logged in.
    QuickAuth.auth.publishAutoReadCode('123456')
    await flush()

    expect(mock.fn).toHaveBeenCalledTimes(2) // initiate + one verify
  })

  it('re-arms on the next attempt — a WebOTP request is spent once it resolves', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    mock.reply({ ...OTP_SENT, sessionId: 'sess_2' })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    expect(web.requests).toHaveLength(2)
    // The superseded attempt's request was torn down, so the browser is never
    // holding two live OTP requests at once.
    expect(web.requests[0]!.aborted).toBe(true)
    expect(web.live()).toHaveLength(1)
  })

  it('drops a code that belongs to a superseded attempt', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    mock.reply({ ...OTP_SENT, sessionId: 'sess_2' })
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    web.requests[0]!.deliver('111111') // late code from attempt #1
    await flush()

    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_SENT'])
  })

  it('tears auto-read down on reset', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    QuickAuth.auth.reset()
    expect(web.requests[0]!.aborted).toBe(true)

    web.requests[0]!.deliver('123456')
    await flush()
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT'])
  })

  it('tears auto-read down once the attempt is verified', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'VERIFIED', sessionId: 'req_onetap', expiresIn: 300 })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    // OneTap fired — no code is coming, so the browser must not be left
    // showing "use the code from SMS" over an already-signed-in user.
    expect(web.requests[0]!.aborted).toBe(true)
  })
})

describe('auto-read — observeOTP alongside the state machine', () => {
  let web: WebOTPMock

  beforeEach(() => {
    resetSdk()
    web = mockWebOTP()
  })
  afterEach(() => web.restore())

  it('emits OTP_AUTO_READ exactly once when both are listening', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    const input = document.createElement('input')
    document.body.appendChild(input)
    const onCode = vi.fn()

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    QuickAuth.auth.observeOTP({ onCode, input })

    web.live()[0]!.deliver('654321')
    await flush()

    expect(onCode).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('654321')
    expect(events.filter((e) => e.type === 'OTP_AUTO_READ')).toHaveLength(1)
    input.remove()
  })

  it('shares one credential request between observeOTP and the state machine', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    QuickAuth.auth.observeOTP({ onCode: vi.fn() })

    // Re-arming is fine; two LIVE requests are not — the browser cancels one
    // of them and that consumer never hears a code.
    expect(web.live()).toHaveLength(1)
  })

  it('disposing an observeOTP subscription leaves the login flow armed', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    const dispose = QuickAuth.auth.observeOTP({ onCode: vi.fn() })
    dispose()

    expect(web.live()).toHaveLength(1)
    web.live()[0]!.deliver('222222')
    await flush()
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_AUTO_READ'])
  })
})

describe('publishAutoReadCode', () => {
  beforeEach(resetSdk)

  it('rejects a non-string / empty code', () => {
    expect(() => QuickAuth.auth.publishAutoReadCode('')).toThrow(/non-empty/)
  })

  it('emits OTP_AUTO_READ and reaches observeOTP subscribers', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })
    const onCode = vi.fn()
    QuickAuth.auth.observeOTP({ onCode })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    QuickAuth.auth.publishAutoReadCode('424242')
    await flush()

    expect(onCode).toHaveBeenCalledWith('424242')
    expect(events.filter((e) => e.type === 'OTP_AUTO_READ')).toEqual([
      { type: 'OTP_AUTO_READ', code: '424242' },
    ])
  })

  it('emits once with no attempt running', async () => {
    const events: AuthEvent[] = []
    initSdk({
      fetch: makeMockFetch().fn as unknown as typeof fetch,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    QuickAuth.auth.publishAutoReadCode('999999')
    await flush()

    expect(events).toEqual([{ type: 'OTP_AUTO_READ', code: '999999' }])
  })

  it('auto-submits when the attempt asked for it', async () => {
    const mock = makeMockFetch()
    mock.reply(OTP_SENT)
    mock.reply(VERIFIED)
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210', autoSubmit: true })
    QuickAuth.auth.publishAutoReadCode('123456')
    await flush()

    expect(mock.fn).toHaveBeenCalledTimes(2)
    const [, init] = mock.fn.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ code: '123456' })
  })
})
