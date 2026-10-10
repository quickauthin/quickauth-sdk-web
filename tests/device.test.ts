import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetDeviceInfoCache,
  captureDeviceInfo,
  parseUserAgent,
} from '../src/attribution/device'
import { buildFingerprint } from '../src/attribution/fingerprint'
import { SDK_VERSION } from '../src/version'

const UA = {
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  firefoxWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
}

describe('parseUserAgent', () => {
  it.each([
    ['chromeAndroid', 'Chrome', '141.0.0.0', 'Android', '14', true],
    ['safariIphone', 'Safari', '17.5', 'iOS', '17.5', true],
    ['chromeIphone', 'Chrome', '141.0.7390.41', 'iOS', '17.5', true],
    ['firefoxWindows', 'Firefox', '131.0', 'Windows', '10', false],
    ['edgeWindows', 'Edge', '141.0.3537.57', 'Windows', '10', false],
    ['samsung', 'Samsung Internet', '26.0', 'Android', '13', true],
    ['safariMac', 'Safari', '18.0', 'macOS', '10.15.7', false],
    ['androidTablet', 'Chrome', '141.0.0.0', 'Android', '13', false],
  ] as const)('%s', (key, browser, bVersion, os, osVersion, mobile) => {
    const r = parseUserAgent(UA[key])
    expect(r.browser).toEqual({ name: browser, version: bVersion })
    expect(r.os).toEqual({ name: os, version: osVersion })
    expect(r.mobile).toBe(mobile)
  })

  it('returns empty fields for an unknown or empty string', () => {
    expect(parseUserAgent('')).toEqual({ browser: {}, os: {} })
    expect(parseUserAgent('curl/8.0')).toEqual({ browser: {}, os: {} })
  })
})

function setNavigator(props: Record<string, unknown>): () => void {
  const saved = Object.keys(props).map((k) => [k, Object.getOwnPropertyDescriptor(navigator, k)] as const)
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(navigator, k, { value: v, configurable: true })
  }
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(navigator, k, d)
      else delete (navigator as unknown as Record<string, unknown>)[k]
    }
  }
}

describe('captureDeviceInfo', () => {
  let restore: (() => void) | null = null
  beforeEach(() => __resetDeviceInfoCache())
  afterEach(() => {
    restore?.()
    restore = null
    __resetDeviceInfoCache()
  })

  it('carries the RN/Flutter-aligned fields', async () => {
    restore = setNavigator({ userAgent: UA.chromeAndroid, language: 'en-IN', userAgentData: undefined })
    const info = await captureDeviceInfo()
    expect(info.platform).toBe('web')
    expect(info.sdk).toBe(`web/${SDK_VERSION}`)
    expect(info.locale).toBe('en-IN')
    expect(info.timeZoneOffsetMinutes).toBe(-new Date().getTimezoneOffset())
    expect(info.appId).toBe(location.host)
    expect(info.osVersion).toBe('Android 14')
    expect(info.osName).toBe('Android')
    expect(info.browserName).toBe('Chrome')
    expect(info.browserVersion).toBe('141.0.0.0')
    expect(info.mobile).toBe(true)
    expect(info.userAgent).toBe(UA.chromeAndroid)
    expect(typeof info.timezone).toBe('string')
    expect(typeof info.screen.pixelRatio).toBe('number')
  })

  it('prefers User-Agent Client Hints for exact OS and browser versions', async () => {
    restore = setNavigator({
      userAgent: UA.edgeWindows,
      userAgentData: {
        brands: [
          { brand: 'Not)A;Brand', version: '99' },
          { brand: 'Chromium', version: '141' },
          { brand: 'Microsoft Edge', version: '141' },
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          platform: 'Windows',
          platformVersion: '15.0.0',
          fullVersionList: [
            { brand: 'Not)A;Brand', version: '99.0.0.0' },
            { brand: 'Chromium', version: '141.0.7390.55' },
            { brand: 'Microsoft Edge', version: '141.0.3537.57' },
          ],
        }),
      },
    })
    const info = await captureDeviceInfo()
    expect(info.osVersion).toBe('Windows 11')
    expect(info.browserName).toBe('Edge')
    expect(info.browserVersion).toBe('141.0.3537.57')
    expect(info.mobile).toBe(false)
  })

  it('falls back to low-entropy brands when high-entropy hints hang', async () => {
    restore = setNavigator({
      userAgent: UA.chromeAndroid,
      userAgentData: {
        brands: [{ brand: 'Google Chrome', version: '141' }],
        mobile: true,
        platform: 'Android',
        getHighEntropyValues: () => new Promise(() => {}),
      },
    })
    const t0 = Date.now()
    const info = await captureDeviceInfo()
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(info.browserName).toBe('Chrome')
    expect(info.browserVersion).toBe('141')
    expect(info.osName).toBe('Android')
    expect(info.osVersion).toBe('Android')
  })

  it('never throws when getHighEntropyValues rejects', async () => {
    restore = setNavigator({
      userAgent: UA.safariIphone,
      userAgentData: { getHighEntropyValues: () => Promise.reject(new Error('denied')) },
    })
    const info = await captureDeviceInfo()
    expect(info.osVersion).toBe('iOS 17.5')
    expect(info.browserName).toBe('Safari')
  })
})

describe('buildFingerprint', () => {
  it('hash inputs are unchanged by the deviceInfo alignment', async () => {
    const fp = await buildFingerprint({
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      platform: 'MacIntel',
      userAgent: 'UA/1',
      screen: { width: 1512, height: 982, colorDepth: 30 },
    })
    expect(fp.hash).toBe('492e99eaabca582089700bda7651af0a91a54b4caaf8ac150fbe9ced18a2b59c')
    expect(fp.hints).toEqual({ timezone: 'Asia/Kolkata', locale: 'en-IN', platform: 'MacIntel' })
  })
})
