import type { BrowserSignals, DeviceInfo } from '../types'
import { SDK_TAG } from '../version'

export function collectBrowserSignals(): BrowserSignals {
  const nav = (typeof navigator !== 'undefined'
    ? navigator
    : ({} as Partial<Navigator>)) as Navigator

  const tz =
    typeof Intl !== 'undefined'
      ? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
      : 'UTC'

  const screenObj =
    typeof screen !== 'undefined'
      ? screen
      : ({ width: 0, height: 0, colorDepth: 0 } as Screen)

  return {
    timezone: tz,
    locale: nav.language ?? 'en',
    screen: {
      width: screenObj.width || 0,
      height: screenObj.height || 0,
      colorDepth: screenObj.colorDepth || 0,
    },
    platform:
      (nav as Navigator & { platform?: string }).platform ?? 'unknown',
    userAgent: nav.userAgent ?? 'unknown',
  }
}

export async function captureDeviceInfo(): Promise<DeviceInfo> {
  const signals = collectBrowserSignals()
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const uad = (nav as NavigatorWithUAData | undefined)?.userAgentData
  const parsed = parseUserAgent(signals.userAgent)
  const hints = await loadHighEntropyHints()

  const os = osFromHints(uad, hints) ?? parsed.os
  const browser = browserFromHints(uad, hints) ?? parsed.browser

  const info: DeviceInfo = {
    platform: 'web',
    locale: signals.locale,
    timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
    sdk: SDK_TAG,
    timezone: signals.timezone,
    userAgent: signals.userAgent,
    screen: {
      ...signals.screen,
      pixelRatio:
        typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
          ? window.devicePixelRatio
          : 1,
    },
  }
  if (os.version) info.osVersion = `${os.name} ${os.version}`
  else if (os.name) info.osVersion = os.name
  if (os.name) info.osName = os.name
  if (browser.name) info.browserName = browser.name
  if (browser.version) info.browserVersion = browser.version
  const mobile = typeof uad?.mobile === 'boolean' ? uad.mobile : parsed.mobile
  if (typeof mobile === 'boolean') info.mobile = mobile
  if (typeof location !== 'undefined' && location.host) info.appId = location.host
  return info
}

interface UABrand {
  brand: string
  version: string
}

interface UADataLike {
  brands?: UABrand[]
  mobile?: boolean
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<HighEntropyHints>
}

interface HighEntropyHints {
  platform?: string
  platformVersion?: string
  fullVersionList?: UABrand[]
}

type NavigatorWithUAData = Navigator & { userAgentData?: UADataLike }

const HINTS_TIMEOUT_MS = 250

let hintsPromise: Promise<HighEntropyHints | null> | null = null

function loadHighEntropyHints(): Promise<HighEntropyHints | null> {
  if (!hintsPromise) hintsPromise = fetchHighEntropyHints()
  return hintsPromise
}

async function fetchHighEntropyHints(): Promise<HighEntropyHints | null> {
  const uad =
    typeof navigator !== 'undefined'
      ? (navigator as NavigatorWithUAData).userAgentData
      : undefined
  if (!uad || typeof uad.getHighEntropyValues !== 'function') return null
  try {
    return await Promise.race([
      uad.getHighEntropyValues(['platformVersion', 'fullVersionList']),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HINTS_TIMEOUT_MS)),
    ])
  } catch {
    return null
  }
}

function isGenericBrand(brand: string): boolean {
  return /not.?a.?brand/i.test(brand) || brand === 'Chromium'
}

function pickBrand(list: UABrand[] | undefined): UABrand | null {
  if (!list?.length) return null
  const real = list.filter((b) => !/not.?a.?brand/i.test(b.brand))
  return real.find((b) => !isGenericBrand(b.brand)) ?? real[0] ?? null
}

function browserFromHints(
  uad: UADataLike | undefined,
  hints: HighEntropyHints | null,
): ParsedUA['browser'] | null {
  const brand = pickBrand(hints?.fullVersionList) ?? pickBrand(uad?.brands)
  if (!brand) return null
  const name = brand.brand.replace(/^Google /, '').replace(/^Microsoft /, '')
  return { name, version: brand.version }
}

function osFromHints(
  uad: UADataLike | undefined,
  hints: HighEntropyHints | null,
): ParsedUA['os'] | null {
  const platform = hints?.platform || uad?.platform
  if (!platform) return null
  const version = hints?.platformVersion
  if (!version) return { name: platform }
  if (platform === 'Windows') {
    const major = parseInt(version, 10)
    if (major >= 13) return { name: 'Windows', version: '11' }
    if (major > 0) return { name: 'Windows', version: '10' }
    return { name: 'Windows' }
  }
  return { name: platform, version: version.replace(/(\.0)+$/, '') || version }
}

export interface ParsedUA {
  browser: { name?: string; version?: string }
  os: { name?: string; version?: string }
  mobile?: boolean
}

export function parseUserAgent(ua: string): ParsedUA {
  const out: ParsedUA = { browser: {}, os: {} }
  if (!ua) return out

  const browsers: Array<[string, RegExp]> = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /(?:OPR|OPiOS)\/([\d.]+)/],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari\//],
  ]
  for (const [name, re] of browsers) {
    const m = ua.match(re)
    if (m) {
      out.browser = { name, version: m[1] }
      break
    }
  }

  let m: RegExpMatchArray | null
  if ((m = ua.match(/(?:iPhone|iPad|iPod).*? OS ([\d_]+)/))) {
    out.os = { name: 'iOS', version: m[1]!.replace(/_/g, '.') }
  } else if ((m = ua.match(/Android ([\d.]+)/))) {
    out.os = { name: 'Android', version: m[1] }
  } else if ((m = ua.match(/Windows NT ([\d.]+)/))) {
    const map: Record<string, string> = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' }
    out.os = { name: 'Windows', version: map[m[1]!] }
  } else if (/CrOS/.test(ua)) {
    out.os = { name: 'Chrome OS' }
  } else if ((m = ua.match(/Mac OS X ([\d_.]+)/))) {
    out.os = { name: 'macOS', version: m[1]!.replace(/_/g, '.') }
  } else if (/Linux/.test(ua)) {
    out.os = { name: 'Linux' }
  }

  if (/Mobi|iPhone|iPod|Android.*Mobile/.test(ua)) out.mobile = true
  else if (/iPad|Tablet|Android/.test(ua)) out.mobile = false
  else if (out.os.name) out.mobile = false

  return out
}

export function __resetDeviceInfoCache(): void {
  hintsPromise = null
}
