import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickAuth } from '../src/index'
import { storage } from '../src/core/storage'
import { fakeJwt, flush, initSdk, makeMockFetch, resetSdk, setUrl } from './_helpers'

const base = { apiBaseUrl: 'https://api.test.local', fetch: (async () => new Response('{}')) as unknown as typeof fetch }

describe('init() validation', () => {
  beforeEach(() => resetSdk())

  it('requires an auth mode', () => {
    expect(() => QuickAuth.init({ ...base })).toThrow(/requires one of: publishableKey \(recommended\), onTokenExpiry, initialToken, or unsafe/)
  })

  it('rejects onTokenExpiry together with unsafe', () => {
    expect(() =>
      QuickAuth.init({
        ...base,
        silent: true,
        onTokenExpiry: async () => fakeJwt(600),
        unsafe: { directClientId: 'qc_x', directClientSecret: 'y' },
      }),
    ).toThrow(/only one auth mode/)
  })

  it('rejects half-filled unsafe credentials', () => {
    expect(() => QuickAuth.init({ ...base, unsafe: { directClientId: 'qc_x' } })).toThrow(/both directClientId and directClientSecret/)
  })

  it('rejects an onTokenExpiry that is not a function', () => {
    expect(() => QuickAuth.init({ ...base, onTokenExpiry: 'tok' as unknown as () => Promise<string> })).toThrow(/must be a function/)
  })

  it('initialToken together with onTokenExpiry is allowed', () => {
    expect(() => QuickAuth.init({ ...base, initialToken: fakeJwt(600), onTokenExpiry: async () => fakeJwt(600) })).not.toThrow()
  })

  it('returns a promise that resolves, so un-awaited calls keep working', async () => {
    const p = QuickAuth.init({ ...base, initialToken: fakeJwt(600) })
    expect(p).toBeInstanceOf(Promise)
    await expect(p).resolves.toBeUndefined()
    expect(QuickAuth.isInitialized).toBe(true)
  })

  it('resolves even when flushing queued requests fails', async () => {
    storage.set('consent', true)
    storage.set('offline_queue', [{ id: 'a', url: 'https://api.test.local/x', body: {}, createdAt: 0, attempts: 0 }])
    const failing = (async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    await expect(QuickAuth.init({ apiBaseUrl: 'https://api.test.local', fetch: failing, initialToken: fakeJwt(600), maxRetries: 0 })).resolves.toBeUndefined()
  })
})

describe('consent — the saved choice wins', () => {
  beforeEach(() => resetSdk())

  it('init({ consent: true }) does not override a saved "no"', () => {
    storage.set('consent', false)
    QuickAuth.init({ ...base, initialToken: fakeJwt(600), consent: true })
    expect(QuickAuth.consent.get()).toBe(false)
  })

  it('init({ consent: false }) does not wipe a saved "yes"', () => {
    storage.set('consent', true)
    QuickAuth.init({ ...base, initialToken: fakeJwt(600), consent: false })
    expect(QuickAuth.consent.get()).toBe(true)
  })

  it('init({ consent }) applies when nothing is saved', () => {
    QuickAuth.init({ ...base, initialToken: fakeJwt(600), consent: true })
    expect(QuickAuth.consent.get()).toBe(true)
  })

  it('consent.set returns a promise and a throwing onChange listener cannot break it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    QuickAuth.init({ ...base, initialToken: fakeJwt(600) })
    const off = QuickAuth.consent.onChange(() => {
      throw new Error('merchant bug')
    })
    await expect(QuickAuth.consent.set(true)).resolves.toBeUndefined()
    expect(QuickAuth.consent.get()).toBe(true)
    off()
    error.mockRestore()
  })
})

describe('captureLaunch is queued until consent', () => {
  beforeEach(() => {
    resetSdk()
    setUrl('http://localhost/?qa_clid=clid_wait')
  })

  it('sends nothing without consent, then sends the launch on grant', async () => {
    const mock = makeMockFetch()
    mock.reply({ matched: true, campaignId: 'cmp_9' })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    const r = await QuickAuth.attribution.captureLaunch()
    expect(r).toEqual({ matched: false, qaClid: 'clid_wait' })
    expect(mock.fn).not.toHaveBeenCalled()
    expect(QuickAuth.consent.pendingCount()).toBe(1)

    await QuickAuth.consent.set(true)
    expect(mock.fn).toHaveBeenCalledTimes(1)
    const [url, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.local/v1/sdk/attribution/launch')
    expect(JSON.parse(init.body as string).qa_clid).toBe('clid_wait')
    expect(QuickAuth.consent.pendingCount()).toBe(0)
    expect(QuickAuth.attribution.getStored()).toMatchObject({ matched: true, campaignId: 'cmp_9' })
  })

  it('pendingCount counts queued conversions and the launch', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })
    await QuickAuth.attribution.captureLaunch()
    await QuickAuth.attribution.trackConversion({ event: 'a' })
    await QuickAuth.attribution.trackConversion({ event: 'b' })
    expect(QuickAuth.consent.pendingCount()).toBe(3)
  })

  it('the queued launch waits while consent stays off', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })
    await QuickAuth.attribution.captureLaunch()
    await QuickAuth.consent.set(false)
    expect(QuickAuth.consent.pendingCount()).toBe(1)
    expect(mock.fn).not.toHaveBeenCalled()
  })

  it('revoking consent clears the stored click id', async () => {
    const mock = makeMockFetch()
    mock.reply({ matched: false })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })
    await QuickAuth.attribution.captureLaunch()
    await QuickAuth.consent.set(true)
    expect(QuickAuth.attribution.qaClid()).toBe('clid_wait')
    await QuickAuth.consent.set(false)
    expect(QuickAuth.attribution.qaClid()).toBeNull()
    expect(QuickAuth.consent.pendingCount()).toBe(0)
  })

  it('a queued launch is sent on the next init() once consent was given', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })
    await QuickAuth.attribution.captureLaunch()
    storage.set('consent', true)
    await QuickAuth.init({ apiBaseUrl: 'https://api.test.local', fetch: mock.fn as unknown as typeof fetch, initialToken: fakeJwt(600) })
    expect(mock.fn).toHaveBeenCalledTimes(1)
    expect((mock.fn.mock.calls[0] as [string])[0]).toContain('/v1/sdk/attribution/launch')
  })

  it('attribution.qaClid() returns the click id', async () => {
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch, consent: false })
    expect(QuickAuth.attribution.qaClid()).toBeNull()
    await QuickAuth.attribution.captureLaunch()
    expect(QuickAuth.attribution.qaClid()).toBe('clid_wait')
  })
})

describe('trackConversion matches RN', () => {
  beforeEach(() => {
    resetSdk()
    setUrl('http://localhost/')
  })

  it('sends only event, value, currency (+ qa_clid / metadata when present)', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch })
    await QuickAuth.attribution.trackConversion({ event: 'signup' })
    const [, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ event: 'signup', value: 0, currency: 'INR' })
  })

  it('a network failure resolves instead of throwing', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('offline')
    })
    initSdk({ fetch: failing as unknown as typeof fetch })
    await expect(QuickAuth.attribution.trackConversion({ event: 'signup' })).resolves.toBeUndefined()
  })

  it('a missing event name still throws', async () => {
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch })
    await expect(QuickAuth.attribution.trackConversion({} as never)).rejects.toThrow(/event is required/)
  })
})

describe('phone input', () => {
  beforeEach(() => resetSdk())

  it('trims surrounding whitespace, like RN', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 's', expiresIn: 60 })
    initSdk({ fetch: mock.fn as unknown as typeof fetch })
    await QuickAuth.auth.initiate({ phone: '  +919876543210 \n' })
    await flush()
    const [, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string).phone).toBe('+919876543210')
  })

  it('still rejects inner spaces and a missing phone', async () => {
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch })
    await expect(QuickAuth.auth.initiate({ phone: '+91 98765 43210' })).rejects.toThrow(/E\.164/)
    await expect(QuickAuth.auth.initiate(undefined as never)).rejects.toThrow(/E\.164/)
  })
})

describe('storage never throws', () => {
  beforeEach(() => resetSdk())

  it('a full localStorage falls back to memory instead of breaking the flow', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string) => {
      if (k !== '__qa_probe__') throw new DOMException('full', 'QuotaExceededError')
    })
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 's', expiresIn: 60, deviceToken: 'dtok' })
    initSdk({ fetch: mock.fn as unknown as typeof fetch })
    await expect(QuickAuth.auth.initiate({ phone: '+919876543210' })).resolves.toBeUndefined()
    expect(storage.get('device_token')).toBe('dtok')
    setItem.mockRestore()
  })
})
