import { getConfig, isConfigured } from './config'

const SENSITIVE = /^(code|token|sessionToken|deviceToken|clientSecret|directClientSecret|authorization)$/i

function flags(): { debug: boolean; silent: boolean } {
  if (!isConfigured()) return { debug: false, silent: false }
  const c = getConfig()
  return { debug: c.debug, silent: c.silent }
}

/** Mask secrets and OTP codes before anything reaches the console. */
export function redact(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) && typeof v === 'string' ? `${'*'.repeat(Math.min(v.length, 6))}(${v.length})` : redact(v)
  }
  return out
}

export const logger = {
  debug(...args: unknown[]): void {
    if (flags().debug && typeof console !== 'undefined') console.log('[QuickAuth]', ...args)
  },
  warn(...args: unknown[]): void {
    if (!flags().silent && typeof console !== 'undefined') console.warn('[QuickAuth]', ...args)
  },
  error(...args: unknown[]): void {
    if (!flags().silent && typeof console !== 'undefined') console.error('[QuickAuth]', ...args)
  },
}
