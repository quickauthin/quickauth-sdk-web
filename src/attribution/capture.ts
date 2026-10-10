import { post } from '../core/client'
import { consent } from '../core/consent'
import { logger } from '../core/logger'
import { storage } from '../core/storage'
import type { AttributionResult } from '../types'
import { captureDeviceInfo, collectBrowserSignals } from './device'
import { buildFingerprint } from './fingerprint'

const STORAGE_KEY = 'attribution'
const PENDING_KEY = 'pending_launch'
const CLID_PARAM = 'qa_clid'

/** Read `qa_clid` from the page URL and match it to its campaign; queued until consent is granted. */
export async function captureLaunch(): Promise<AttributionResult> {
  const qaClid = readClid()

  if (!qaClid) {
    return storage.get<AttributionResult>(STORAGE_KEY) ?? { matched: false }
  }

  const skeleton: AttributionResult = { matched: false, qaClid }
  storage.set(STORAGE_KEY, skeleton)

  if (!consent.get()) {
    storage.set(PENDING_KEY, qaClid)
    logger.debug('attribution launch queued until consent')
    return skeleton
  }

  storage.remove(PENDING_KEY)
  return sendLaunch(qaClid)
}

async function sendLaunch(qaClid: string): Promise<AttributionResult> {
  const skeleton: AttributionResult = { matched: false, qaClid }
  try {
    const fingerprint = await buildFingerprint(collectBrowserSignals())
    const deviceInfo = await captureDeviceInfo()
    const result = await post<AttributionResult>('/v1/sdk/attribution/launch', {
      qa_clid: qaClid,
      fingerprint,
      deviceInfo,
    })
    const merged: AttributionResult = {
      matched: !!result?.matched,
      campaignId: result?.campaignId,
      templateId: result?.templateId,
      variantId: result?.variantId,
      qaClid,
    }
    storage.set(STORAGE_KEY, merged)
    return merged
  } catch (err) {
    logger.debug('attribution launch failed:', err instanceof Error ? err.message : err)
    return skeleton
  }
}

export async function flushPendingLaunch(): Promise<void> {
  const qaClid = storage.get<string>(PENDING_KEY)
  if (!qaClid || !consent.get()) return
  storage.remove(PENDING_KEY)
  await sendLaunch(qaClid)
}

export function hasPendingLaunch(): boolean {
  return !!storage.get<string>(PENDING_KEY)
}

/** The `qa_clid` of the most recent WhatsApp click, if any. */
export function getQaClid(): string | null {
  return storage.get<AttributionResult>(STORAGE_KEY)?.qaClid ?? null
}

export function getStoredAttribution(): AttributionResult | null {
  return storage.get<AttributionResult>(STORAGE_KEY)
}

export function clearAttribution(): void {
  storage.remove(STORAGE_KEY)
  storage.remove(PENDING_KEY)
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
