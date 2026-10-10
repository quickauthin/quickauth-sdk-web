import { beforeEach, describe, expect, it } from 'vitest'
import { QuickAuth } from '../src/index'
import { fakeJwt, initSdk, makeMockFetch, resetSdk, setUrl } from './_helpers'

describe('consent gate', () => {
  beforeEach(() => {
    resetSdk()
    setUrl('http://localhost/')
  })

  it('blocks trackConversion from sending while consent=false', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.attribution.trackConversion({ event: 'signup' })
    expect(mock.fn).not.toHaveBeenCalled()
    expect(QuickAuth.consent.get()).toBe(false)
  })

  it('flushes the queued event after consent is granted', async () => {
    const mock = makeMockFetch()
    mock.reply({ ok: true })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.attribution.trackConversion({ event: 'signup' })
    expect(mock.fn).toHaveBeenCalledTimes(0)

    QuickAuth.consent.set(true)
    await new Promise((r) => setTimeout(r, 10))

    expect(mock.fn).toHaveBeenCalledTimes(1)
    const [url, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/sdk/attribution/conversion')
    expect(JSON.parse(init.body as string).event).toBe('signup')
  })

  it('purges queued data when consent is revoked', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.attribution.trackConversion({ event: 'signup' })
    QuickAuth.consent.set(false)
    QuickAuth.consent.set(true)
    QuickAuth.consent.set(false)

    expect(QuickAuth.consent.get()).toBe(false)
    await QuickAuth.attribution.trackConversion({ event: 'login' })
    const calls = mock.fn.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).event,
    )
    expect(calls).not.toContain('login')
  })

  it('init() default has consent off', () => {
    const mock = makeMockFetch()
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      fetch: mock.fn as unknown as typeof fetch,
      initialToken: fakeJwt(600),
    })
    expect(QuickAuth.consent.get()).toBe(false)
  })
})
