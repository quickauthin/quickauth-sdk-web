import type { AuthEventHandler, InitOptions, UnsafeDirectCredentials } from '../types'
import { setAuthEventHandler } from './events'
import { storage } from './storage'

export interface ResolvedConfig {
  apiBaseUrl: string
  maxRetries: number
  requestTimeoutMs: number
  debug: boolean
  silent: boolean
  storagePrefix: string
  fetchImpl: typeof fetch
  publishableKey?: string
  onTokenExpiry?: () => Promise<string>
  initialToken?: string
  unsafe?: UnsafeDirectCredentials
  onAuthEvent?: AuthEventHandler
}

let current: ResolvedConfig | null = null

const DEFAULT_BASE_URL = 'https://api.quickauth.in'
const DEFAULT_TIMEOUT_MS = 15_000

export function configure(opts: InitOptions): ResolvedConfig {
  if (!opts || typeof opts !== 'object') {
    throw new Error('[QuickAuth] init() requires an options object')
  }

  if (opts.onTokenExpiry !== undefined && typeof opts.onTokenExpiry !== 'function') {
    throw new Error('[QuickAuth] init() onTokenExpiry must be a function that returns a session token')
  }
  if (opts.unsafe && !(opts.unsafe.directClientId && opts.unsafe.directClientSecret)) {
    throw new Error('[QuickAuth] init() unsafe needs both directClientId and directClientSecret')
  }

  if (opts.publishableKey !== undefined && typeof opts.publishableKey !== 'string') {
    throw new Error('[QuickAuth] init() publishableKey must be a string')
  }

  const hasPublishableKey =
    typeof opts.publishableKey === 'string' && opts.publishableKey.length > 0
  const hasUnsafe = !!opts.unsafe
  const hasCallback = typeof opts.onTokenExpiry === 'function'
  const hasInitialToken =
    typeof opts.initialToken === 'string' && opts.initialToken.length > 0

  if (hasPublishableKey && (hasCallback || hasInitialToken || hasUnsafe)) {
    throw new Error(
      '[QuickAuth] init() accepts only one auth mode: publishableKey cannot be combined with onTokenExpiry, initialToken or unsafe',
    )
  }
  if (hasCallback && hasUnsafe) {
    throw new Error(
      '[QuickAuth] init() accepts only one auth mode: pass either onTokenExpiry or unsafe — not both',
    )
  }
  if (!hasPublishableKey && !hasCallback && !hasInitialToken && !hasUnsafe) {
    throw new Error(
      '[QuickAuth] init() requires one of: publishableKey (recommended), onTokenExpiry, initialToken, or unsafe.{directClientId, directClientSecret}',
    )
  }

  if (hasUnsafe && !opts.silent && typeof console !== 'undefined') {
    console.warn(
      '[QuickAuth] UNSAFE: client_secret embedded in client — only use in trusted-deployment scenarios. Use onTokenExpiry instead for browser/mobile apps.',
    )
  }

  const fetchImpl =
    opts.fetch ??
    (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined)

  if (!fetchImpl) {
    throw new Error('[QuickAuth] no fetch implementation available')
  }

  const prefix = opts.storagePrefix ?? 'qa_'
  storage.setPrefix(prefix)

  current = {
    apiBaseUrl: (opts.apiBaseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    maxRetries: typeof opts.maxRetries === 'number' ? opts.maxRetries : 3,
    requestTimeoutMs:
      typeof opts.requestTimeoutMs === 'number' && opts.requestTimeoutMs >= 0
        ? opts.requestTimeoutMs
        : DEFAULT_TIMEOUT_MS,
    debug: opts.debug === true,
    silent: opts.silent === true,
    storagePrefix: prefix,
    fetchImpl,
    publishableKey: hasPublishableKey ? opts.publishableKey : undefined,
    onTokenExpiry: opts.onTokenExpiry,
    initialToken: opts.initialToken,
    unsafe: hasUnsafe ? opts.unsafe : undefined,
    onAuthEvent: opts.onAuthEvent,
  }
  setAuthEventHandler(opts.onAuthEvent ?? null)
  return current
}

export function getConfig(): ResolvedConfig {
  if (!current) {
    throw new Error(
      '[QuickAuth] SDK not initialised — call QuickAuth.init({ publishableKey }) first',
    )
  }
  return current
}

export function isConfigured(): boolean {
  return current !== null
}

export function __resetConfig(): void {
  current = null
}
