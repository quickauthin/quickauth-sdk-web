import { post } from '../core/client'
import type { TrackConversionOptions } from '../types'
import { getStoredAttribution } from './capture'

/**
 * Send a conversion event back to QuickAuth. Consent-gated — when the user
 * hasn't granted tracking consent the request is queued in localStorage and
 * flushed automatically once `consent.set(true)` is called.
 */
export async function trackConversion(
  opts: TrackConversionOptions,
): Promise<void> {
  if (!opts || typeof opts.event !== 'string' || !opts.event) {
    throw new Error('[QuickAuth] trackConversion: event is required')
  }
  const attribution = getStoredAttribution()
  await post(
    '/v1/sdk/attribution/conversion',
    {
      event: opts.event,
      value: opts.value ?? 0,
      currency: opts.currency ?? 'INR',
      qa_clid: attribution?.qaClid,
      campaignId: attribution?.campaignId,
      templateId: attribution?.templateId,
      variantId: attribution?.variantId,
      metadata: opts.metadata ?? {},
      occurredAt: Date.now(),
    },
    { consentGated: true },
  )
}
