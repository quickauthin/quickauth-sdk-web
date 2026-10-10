import type { BrowserSignals, FingerprintEnvelope } from '../types'
import { collectBrowserSignals } from './device'

export async function buildFingerprint(
  device?: BrowserSignals,
): Promise<FingerprintEnvelope> {
  const info = device ?? collectBrowserSignals()
  const canonical = [
    info.timezone,
    info.locale,
    info.platform,
    info.userAgent,
    `${info.screen.width}x${info.screen.height}x${info.screen.colorDepth}`,
  ].join('|')

  const hash = await sha256(canonical)
  return {
    hash,
    hints: {
      timezone: info.timezone,
      locale: info.locale,
      platform: info.platform,
    },
  }
}

async function sha256(input: string): Promise<string> {
  const subtle =
    (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (subtle && typeof TextEncoder !== 'undefined') {
    const buf = new TextEncoder().encode(input)
    const digest = await subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  )
}
