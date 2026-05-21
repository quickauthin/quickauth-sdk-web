import { beforeEach, describe, expect, it } from 'vitest'
import { QuickAuth } from '../src/index'
import { fakeJwt, initSdk, makeMockFetch, resetSdk } from './_helpers'

describe('QuickAuth.init', () => {
  beforeEach(resetSdk)

  it('rejects when no auth source is provided', () => {
    expect(() => QuickAuth.init({})).toThrow(/onTokenExpiry/)
  })

  it('accepts onTokenExpiry alone', () => {
    expect(() =>
      QuickAuth.init({ onTokenExpiry: async () => fakeJwt(600) }),
    ).not.toThrow()
  })

  it('accepts initialToken alone', () => {
    expect(() =>
      QuickAuth.init({ initialToken: fakeJwt(600) }),
    ).not.toThrow()
  })

  it('exposes a version string', () => {
    expect(QuickAuth.version).toMatch(/^0\.1\.0$/)
  })
})

describe('QuickAuth.auth.startOTP / verifyOTP', () => {
  beforeEach(resetSdk)

  it('validates phone is E.164', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch })
    await expect(
      QuickAuth.auth.startOTP({ phone: '9876543210' }),
    ).rejects.toThrow(/E\.164/i)
    expect(mock.fn).not.toHaveBeenCalled()
  })

  it('posts initiate with phone + channel', async () => {
    const mock = makeMockFetch()
    mock.reply({ sessionId: 'sess_1', expiresIn: 300 })
    const token = fakeJwt(600)
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      initialToken: token,
    })

    const session = await QuickAuth.auth.startOTP({
      phone: '+919876543210',
      channel: 'whatsapp',
    })

    expect(session).toEqual({ sessionId: 'sess_1', expiresIn: 300 })
    expect(mock.fn).toHaveBeenCalledTimes(1)
    const [url, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.local/v1/sdk/auth/initiate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      phone: '+919876543210',
      channel: 'whatsapp',
    })
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${token}`)
    expect(headers['Idempotency-Key']).toBeTruthy()
  })

  it('verifyOTP posts correct body and returns parsed JWT', async () => {
    const mock = makeMockFetch()
    mock.reply({ jwt: 'jwt_token', expiresIn: 60 })
    initSdk({ fetch: mock.fn as unknown as typeof fetch })

    const result = await QuickAuth.auth.verifyOTP({
      sessionId: 'sess_1',
      code: '123456',
    })

    expect(result.jwt).toBe('jwt_token')
    expect(result.expiresIn).toBe(60)
    const [url, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.local/v1/sdk/auth/verify')
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 'sess_1',
      code: '123456',
    })
  })

  it('verifyOTP rejects malformed code', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch })
    await expect(
      QuickAuth.auth.verifyOTP({ sessionId: 'sess_1', code: 'abc' }),
    ).rejects.toThrow(/digits/)
  })

  it('throws when called before init', async () => {
    await expect(
      QuickAuth.auth.startOTP({ phone: '+919876543210' }),
    ).rejects.toThrow(/init/)
  })
})

describe('QuickAuth.auth.startWhatsAppLogin', () => {
  beforeEach(resetSdk)

  it('builds a wa.me URL with the business number', () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch })
    const url = QuickAuth.auth.startWhatsAppLogin({
      businessNumber: '+91 95749 80048',
    })
    expect(url.startsWith('https://wa.me/919574980048?')).toBe(true)
  })
})
