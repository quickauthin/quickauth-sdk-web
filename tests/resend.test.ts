import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const sent = (sessionId: string): Record<string, unknown> => ({
  state: 'OTP_SENT',
  sessionId,
  expiresIn: 300,
  deviceToken: 'dtok',
})

describe('QuickAuth.auth.resendOtp', () => {
  beforeEach(resetSdk)

  it('rejects when there is no attempt to resend', async () => {
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch })
    await expect(QuickAuth.auth.resendOtp()).rejects.toThrow(
      /nothing to resend/i,
    )
  })

  it('replays the phone of the current attempt without being given it again', async () => {
    const mock = makeMockFetch()
    mock.reply(sent('sess_1'))
    mock.reply(sent('sess_2'))
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.resendOtp()

    const [url, init] = mock.fn.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://api.test.local/v1/sdk/auth/initiate')
    expect(JSON.parse(init.body as string)).toMatchObject({
      phone: '+919876543210',
    })
  })

  it('carries the original channel forward instead of reverting to auto', async () => {
    const mock = makeMockFetch()
    mock.reply(sent('sess_1'))
    mock.reply(sent('sess_2'))
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })

    await QuickAuth.auth.initiate({
      phone: '+919876543210',
      channel: 'whatsapp',
    })
    await QuickAuth.auth.resendOtp()
    await flush()

    const [, init] = mock.fn.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({
      channel: 'whatsapp',
    })
    const otpSent = events.filter(
      (e): e is Extract<AuthEvent, { type: 'OTP_SENT' }> =>
        e.type === 'OTP_SENT',
    )
    expect(otpSent.map((e) => e.channel)).toEqual(['whatsapp', 'whatsapp'])
    expect(otpSent[1]!.sessionId).toBe('sess_2')
  })

  it('is resendable after a failed send — that is when users press it', async () => {
    const mock = makeMockFetch()
    mock.failOnce(500)
    mock.reply(sent('sess_2'))
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await expect(
      QuickAuth.auth.initiate({ phone: '+919876543210' }),
    ).rejects.toBeDefined()
    await expect(QuickAuth.auth.resendOtp()).resolves.toBeUndefined()
  })

  it('rejects after reset — the attempt is over', async () => {
    const mock = makeMockFetch()
    mock.reply(sent('sess_1'))
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    QuickAuth.auth.reset()

    await expect(QuickAuth.auth.resendOtp()).rejects.toThrow(
      /nothing to resend/i,
    )
  })
})

describe('QuickAuth.auth.resendOtp — auto-read', () => {
  let web: WebOTPMock

  beforeEach(() => {
    resetSdk()
    web = mockWebOTP()
  })
  afterEach(() => web.restore())

  it('carries autoSubmit forward and re-arms a fresh request', async () => {
    const mock = makeMockFetch()
    mock.reply(sent('sess_1'))
    mock.reply(sent('sess_2'))
    mock.reply({
      state: 'VERIFIED',
      verified: true,
      requestId: 'req_ok',
      message: 'ok',
    })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210', autoSubmit: true })
    await QuickAuth.auth.resendOtp()

    expect(web.requests).toHaveLength(2)
    expect(web.requests[0]!.aborted).toBe(true)

    web.live()[0]!.deliver('123456')
    await flush()

    // Third call is the verify — autoSubmit survived the resend, and the
    // latch was re-armed for the new attempt.
    expect(mock.fn).toHaveBeenCalledTimes(3)
    const [url, init] = mock.fn.mock.calls[2] as [string, RequestInit]
    expect(url).toBe('https://api.test.local/v1/sdk/auth/verify')
    expect(JSON.parse(init.body as string)).toMatchObject({
      sessionId: 'sess_2',
      code: '123456',
    })
  })
})
