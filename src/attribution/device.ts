import type { DeviceInfo } from '../types'

/**
 * Snapshot a small set of low-entropy device signals. The caller is responsible
 * for gating this with consent — `device.ts` itself never touches storage or
 * network.
 */
export function collectDeviceInfo(): DeviceInfo {
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
