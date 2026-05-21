import { beforeEach, describe, expect, it } from 'vitest'
import { QuickAuth } from '../src/index'
import { initSdk, makeMockFetch, resetSdk, setUrl } from './_helpers'

describe('attribution.captureLaunch', () => {
  beforeEach(() => {
    resetSdk()
    setUrl('http://localhost/')
  })

  it('returns matched=false when no qa_clid is present', async () => {
    const mock = makeMockFetch()
    initSdk({ fetch: mock.fn as unknown as typeof fetch })
    const r = await QuickAuth.attribution.captureLaunch()
    expect(r.matched).toBe(false)
    expect(mock.fn).not.toHaveBeenCalled()
  })

  it('parses qa_clid and posts to /v1/sdk/attribution/launch', async () => {
    setUrl('http://localhost/?qa_clid=abc123&utm_source=wa')
    const mock = makeMockFetch()
    mock.reply({
      matched: true,
      campaignId: 'cmp_1',
      templateId: 'tpl_2',
      variantId: 'var_a',
    })
    initSdk({ fetch: mock.fn as unknown as typeof fetch })

    const result = await QuickAuth.attribution.captureLaunch()

    expect(result.matched).toBe(true)
    expect(result.campaignId).toBe('cmp_1')
    expect(result.qaClid).toBe('abc123')

    const [url, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.local/v1/sdk/attribution/launch')
    const payload = JSON.parse(init.body as string)
    expect(payload.qa_clid).toBe('abc123')
    expect(payload.fingerprint.hash).toMatch(/^[0-9a-f]+$/)
    expect(payload.deviceInfo.timezone).toBeTruthy()
  })

  it('skips backend when consent is false but still remembers qa_clid', async () => {
    setUrl('http://localhost/?qa_clid=keep-me')
    const mock = makeMockFetch()
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
    })

    const result = await QuickAuth.attribution.captureLaunch()
    expect(result.matched).toBe(false)
    expect(result.qaClid).toBe('keep-me')
    expect(mock.fn).not.toHaveBeenCalled()
  })
})

describe('attribution.trackConversion', () => {
  beforeEach(() => {
    resetSdk()
    setUrl('http://localhost/?qa_clid=track-me')
  })

  it('attaches the stored qa_clid to the conversion payload', async () => {
    const mock = makeMockFetch()
    mock.reply({
      matched: true,
      campaignId: 'cmp_1',
      templateId: 'tpl_2',
      variantId: 'var_a',
    })
    mock.reply({ ok: true })
    initSdk({ fetch: mock.fn as unknown as typeof fetch })

    await QuickAuth.attribution.captureLaunch()
    await QuickAuth.attribution.trackConversion({
      event: 'signup',
      value: 0,
      currency: 'INR',
      metadata: { plan: 'free' },
    })

    expect(mock.fn).toHaveBeenCalledTimes(2)
    const [, init] = mock.fn.mock.calls[1] as [string, RequestInit]
    const payload = JSON.parse(init.body as string)
    expect(payload.event).toBe('signup')
    expect(payload.qa_clid).toBe('track-me')
    expect(payload.campaignId).toBe('cmp_1')
    expect(payload.metadata).toEqual({ plan: 'free' })
  })
})
