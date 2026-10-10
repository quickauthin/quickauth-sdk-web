import { beforeEach, describe, expect, it } from 'vitest'
import { QuickAuth } from '../src/index'
import { fakeJwt, makeMockFetch, resetSdk } from './_helpers'

const PK = 'pk_test_abc123'

function initWithKey(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): void {
  QuickAuth.init({
    apiBaseUrl: 'https://api.test.local',
    consent: true,
    fetch: fetchImpl,
    maxRetries: 0,
    publishableKey: PK,
    ...extra,
  })
}

describe('publishableKey mode', () => {
  beforeEach(resetSdk)

  it('init accepts publishableKey alone', () => {
    expect(() => initWithKey(makeMockFetch().fn as unknown as typeof fetch)).not.toThrow()
    expect(QuickAuth.config.publishableKey).toBe(PK)
  })

  it.each([
    ['onTokenExpiry', { onTokenExpiry: async () => fakeJwt(600) }],
    ['initialToken', { initialToken: fakeJwt(600) }],
    ['unsafe', { silent: true, unsafe: { directClientId: 'qc_x', directClientSecret: 'y' } }],
  ])('rejects publishableKey combined with %s', (_name, extra) => {
    expect(() => initWithKey(makeMockFetch().fn as unknown as typeof fetch, extra)).toThrow(/only one auth mode/)
  })

  it('rejects a publishableKey that is not a string', () => {
    expect(() => QuickAuth.init({ publishableKey: 42 as unknown as string })).toThrow(/publishableKey must be a string/)
  })

  it('treats an empty publishableKey as no auth mode', () => {
    expect(() => QuickAuth.init({ publishableKey: '' })).toThrow(/requires one of/)
  })

  it('sends X-QuickAuth-Key and no Authorization header', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    initWithKey(mock.fn as unknown as typeof fetch)

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    expect(mock.fn).toHaveBeenCalledTimes(1)
    const [url, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).not.toContain('/v1/sdk/session')
    expect(headers['X-QuickAuth-Key']).toBe(PK)
    expect(headers.Authorization).toBeUndefined()
  })

  it('does not retry a 401 by refreshing a token', async () => {
    const mock = makeMockFetch()
    mock.failOnce(401)
    initWithKey(mock.fn as unknown as typeof fetch)

    await QuickAuth.auth.initiate({ phone: '+919876543210' }).catch(() => undefined)

    expect(mock.fn).toHaveBeenCalledTimes(1)
  })

  it('tokenManager.getToken() rejects — there is no session token', async () => {
    initWithKey(makeMockFetch().fn as unknown as typeof fetch)
    await expect(QuickAuth.tokenManager.getToken()).rejects.toThrow(/publishableKey mode/)
  })
})
