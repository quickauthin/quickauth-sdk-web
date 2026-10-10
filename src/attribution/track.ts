import { post } from '../core/client'
import { logger } from '../core/logger'
import type { TrackConversionOptions } from '../types'
import { getQaClid } from './capture'

/** Send a conversion event; queued until consent is granted. Network failures are logged, not thrown. */
export async function trackConversion(opts: TrackConversionOptions): Promise<void> {
  if (!opts || typeof opts.event !== 'string' || !opts.event) {
    throw new Error('[QuickAuth] trackConversion: event is required')
  }
  const body: Record<string, unknown> = {
    event: opts.event,
    value: opts.value ?? 0,
    currency: opts.currency ?? 'INR',
  }
  const qaClid = getQaClid()
  if (qaClid) body.qa_clid = qaClid
  if (opts.metadata) body.metadata = opts.metadata
  try {
    await post('/v1/sdk/attribution/conversion', body, { consentGated: true })
  } catch (err) {
    logger.debug('conversion failed:', err instanceof Error ? err.message : err)
  }
}
