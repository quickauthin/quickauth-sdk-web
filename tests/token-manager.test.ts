import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickAuth } from '../src/index'
import { decodeJwtExp } from '../src/core/token'
import { fakeJwt, makeMockFetch, resetSdk } from './_helpers'

describe('decodeJwtExp', () => {
  it('decodes the exp claim from a well-formed JWT', () => {
    const token = fakeJwt(120)
    const exp = decodeJwtExp(token)
    expect(exp).not.toBeNull()
    // Within ~1s of "now + 120s".
    expect(Math.abs((exp ?? 0) - (Date.now() + 120_000))).toBeLessThan(2_000)
  })

  it('returns null on malformed JWTs', () => {
    expect(decodeJwtExp('not-a-jwt')).toBeNull()
    expect(decodeJwtExp('a.b')).toBeNull()
    expect(decodeJwtExp('')).toBeNull()
  })
})

describe('TokenManager — onTokenExpiry callback', () => {
  beforeEach(resetSdk)

  it('calls onTokenExpiry when no token is cached', async () => {
    const mock = makeMockFetch()
    mock.reply({ sessionId: 's', expiresIn: 1 })
    const token = fakeJwt(600)
    const onTokenExpiry = vi.fn(async () => token)

    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: true,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      onTokenExpiry,
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    expect(onTokenExpiry).toHaveBeenCalledTimes(1)
    const headers = (mock.fn.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${token}`)
  })

  it('refreshes when current token has <30s remaining', async () => {
    const mock = makeMockFetch()
    mock.reply({ sessionId: 's1', expiresIn: 1 })
    mock.reply({ sessionId: 's2', expiresIn: 1 })

    const expiringSoon = fakeJwt(10) // 10s remaining — under the 30s buffer
    const fresh = fakeJwt(600)
    const onTokenExpiry = vi.fn(async () => fresh)

    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: true,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      initialToken: expiringSoon,
      onTokenExpiry,
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    // Initial token expires in 10s — under the 30s buffer — should refresh.
    expect(onTokenExpiry).toHaveBeenCalledTimes(1)
    const headers = (mock.fn.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${fresh}`)
  })

  it('reuses the cached token when it is still fresh', async () => {
    const mock = makeMockFetch()
    mock.reply({ sessionId: 's1', expiresIn: 1 })
    mock.reply({ sessionId: 's2', expiresIn: 1 })

    const fresh = fakeJwt(600)
    const onTokenExpiry = vi.fn(async () => fakeJwt(600))

    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: true,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      initialToken: fresh,
      onTokenExpiry,
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    // Both calls share the still-fresh initial token — no refresh needed.
    expect(onTokenExpiry).not.toHaveBeenCalled()
  })

  it('attaches Bearer token header on every POST', async () => {
    const mock = makeMockFetch()
    mock.reply({ sessionId: 's1', expiresIn: 1 })
    mock.reply({ jwt: 'j', expiresIn: 1 })
    const token = fakeJwt(600)

    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: true,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      initialToken: token,
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await QuickAuth.auth.submitOtp('1234')

    for (const call of mock.fn.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe(`Bearer ${token}`)
    }
  })

  it('single-flight: 5 concurrent calls trigger one onTokenExpiry', async () => {
    const mock = makeMockFetch()
    for (let i = 0; i < 5; i++) mock.reply({ sessionId: `s${i}`, expiresIn: 1 })

    let resolveRefresh!: (token: string) => void
    const onTokenExpiry = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolveRefresh = res
        }),
    )

    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: true,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      onTokenExpiry,
    })

    // Fire 5 concurrent calls — only one refresh should be in flight.
    const calls = Array.from({ length: 5 }, () =>
      QuickAuth.auth.initiate({ phone: '+919876543210' }),
    )
    // Yield once so all callers register their listeners on the in-flight refresh.
    await new Promise((r) => setTimeout(r, 0))
    expect(onTokenExpiry).toHaveBeenCalledTimes(1)

    resolveRefresh(fakeJwt(600))
    await Promise.all(calls)
    expect(onTokenExpiry).toHaveBeenCalledTimes(1)
  })

  it('on 401 response, invalidates and retries once with a new token', async () => {
    const mock = makeMockFetch()
    mock.failOnce(401)
    mock.reply({ sessionId: 'after-refresh', expiresIn: 1 })

    const first = fakeJwt(600)
    const second = fakeJwt(600)
    let count = 0
    const onTokenExpiry = vi.fn(async () => {
      count++
      return count === 1 ? first : second
    })

    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: true,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      onTokenExpiry,
    })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    expect(mock.fn).toHaveBeenCalledTimes(2)
    expect(onTokenExpiry).toHaveBeenCalledTimes(2)

    const firstHeaders = (mock.fn.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>
    const secondHeaders = (mock.fn.mock.calls[1]![1] as RequestInit)
      .headers as Record<string, string>
    expect(firstHeaders['Authorization']).toBe(`Bearer ${first}`)
    expect(secondHeaders['Authorization']).toBe(`Bearer ${second}`)
  })
})

describe('TokenManager — unsafe direct credentials', () => {
  beforeEach(resetSdk)

  it('mints via /v1/sdk/session and prints a console warning', async () => {
    const mock = makeMockFetch()
    const minted = fakeJwt(600)
    // First call: /v1/sdk/session minting response.
    mock.reply({ sessionToken: minted })
    // Second call: the actual startOTP endpoint.
    mock.reply({ sessionId: 's', expiresIn: 1 })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      consent: true,
      fetch: mock.fn as unknown as typeof fetch,
      maxRetries: 0,
      unsafe: {
        directClientId: 'cid_123',
        directClientSecret: 'csecret_xyz',
      },
    })

    expect(warn).toHaveBeenCalled()
    const warnMsg = (warn.mock.calls[0]![0] as string) ?? ''
    expect(warnMsg).toMatch(/UNSAFE/)

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    expect(mock.fn).toHaveBeenCalledTimes(2)
    const [mintUrl, mintInit] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(mintUrl).toBe('https://api.test.local/v1/sdk/session')
    const mintHeaders = mintInit.headers as Record<string, string>
    expect(mintHeaders['X-Client-Id']).toBe('cid_123')
    expect(mintHeaders['X-Client-Secret']).toBe('csecret_xyz')

    const [otpUrl, otpInit] = mock.fn.mock.calls[1] as [string, RequestInit]
    expect(otpUrl).toBe('https://api.test.local/v1/sdk/auth/initiate')
    const otpHeaders = otpInit.headers as Record<string, string>
    expect(otpHeaders['Authorization']).toBe(`Bearer ${minted}`)

    warn.mockRestore()
  })
})
