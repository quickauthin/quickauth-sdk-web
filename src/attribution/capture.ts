import { post } from '../core/client'
import { consent } from '../core/consent'
import { storage } from '../core/storage'
import type { AttributionResult } from '../types'
import { collectDeviceInfo } from './device'
import { buildFingerprint } from './fingerprint'

const STORAGE_KEY = 'attribution'
const CLID_PARAM = 'qa_clid'

/**
 * Parse the launch URL for `qa_clid`, ping the backend for a match, and store
 * the resolved campaign tuple for later `trackConversion()` calls.
 *
 * Safe to call without consent — when consent=false we skip the backend ping
 * and return `{ matched: false }` (we still preserve the qa_clid for later).
 */
export async function captureLaunch(): Promise<AttributionResult> {
  const qaClid = readClid()

  if (!qaClid) {
    // Fall back to whatever we previously stored (e.g. a SPA navigation).
    const cached = storage.get<AttributionResult>(STORAGE_KEY)
    return cached ?? { matched: false }
  }

  // Always remember the click id locally so trackConversion can attach it.
  const skeleton: AttributionResult = { matched: false, qaClid }
  storage.set(STORAGE_KEY, skeleton)

  if (!consent.get()) {
    return skeleton
  }

  const device = collectDeviceInfo()
  const fingerprint = await buildFingerprint(device)

  try {
    const result = await post<AttributionResult>(
      '/v1/sdk/attribution/launch',
      { qa_clid: qaClid, fingerprint, deviceInfo: device },
    )
    const merged: AttributionResult = {
      matched: !!result?.matched,
      campaignId: result?.campaignId,
      templateId: result?.templateId,
      variantId: result?.variantId,
      qaClid,
    }
    storage.set(STORAGE_KEY, merged)
    return merged
  } catch {
    return skeleton
  }
}

export function getStoredAttribution(): AttributionResult | null {
  return storage.get<AttributionResult>(STORAGE_KEY)
}

export function clearAttribution(): void {
  storage.remove(STORAGE_KEY)
}

function readClid(): string | null {
  if (typeof window === 'undefined' || !window.location) return null
  try {
    const url = new URL(window.location.href)
    return url.searchParams.get(CLID_PARAM)
  } catch {
    return null
  }
}
