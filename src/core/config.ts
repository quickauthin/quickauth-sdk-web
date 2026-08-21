import type { AuthEventHandler, InitOptions, UnsafeDirectCredentials } from '../types'
import { setAuthEventHandler } from './events'
import { storage } from './storage'

export interface ResolvedConfig {
  apiBaseUrl: string
  maxRetries: number
  storagePrefix: string
  fetchImpl: typeof fetch
  onTokenExpiry?: () => Promise<string>
  publishableKey?: string
  /** True when a non-empty publishableKey was supplied — see {@link configure}. */
  isPublishableKeyMode: boolean
  initialToken?: string
  unsafe?: UnsafeDirectCredentials
  onAuthEvent?: AuthEventHandler
}

let current: ResolvedConfig | null = null

const DEFAULT_BASE_URL = 'https://api.quickauth.in'

export function configure(opts: InitOptions): ResolvedConfig {
  if (!opts || typeof opts !== 'object') {
    throw new Error('[QuickAuth] init() requires an options object')
  }

  const hasUnsafe = !!(
    opts.unsafe &&
    opts.unsafe.directClientId &&
    opts.unsafe.directClientSecret
  )
  const hasCallback = typeof opts.onTokenExpiry === 'function'
  const hasInitialToken =
    typeof opts.initialToken === 'string' && opts.initialToken.length > 0

  const isPublishableKeyMode =
    typeof opts.publishableKey === 'string' && opts.publishableKey.length > 0
  // Every one of these feeds the token manager, so any of them means the
  // caller is asking for session-token mode.
  const hasSessionTokenSource = hasCallback || hasInitialToken || hasUnsafe

  if (!isPublishableKeyMode && !hasSessionTokenSource) {
    throw new Error(
      '[QuickAuth] init() requires an auth mode: pass publishableKey (recommended, zero-backend) or onTokenExpiry (server-minted session tokens).',
    )
  }

  // The two modes send different credentials on every request, so accepting
  // both would silently pick one and leave the other looking configured.
  if (isPublishableKeyMode && hasSessionTokenSource) {
    throw new Error(
      '[QuickAuth] init() accepts either publishableKey or onTokenExpiry — not both.',
    )
  }

  if (hasUnsafe && typeof console !== 'undefined') {
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
    storagePrefix: prefix,
    fetchImpl,
    onTokenExpiry: opts.onTokenExpiry,
    publishableKey: isPublishableKeyMode ? opts.publishableKey : undefined,
    isPublishableKeyMode,
    initialToken: opts.initialToken,
    unsafe: hasUnsafe ? opts.unsafe : undefined,
    onAuthEvent: opts.onAuthEvent,
  }
  // Register the merchant's single auth event handler. Passing undefined
  // clears any prior handler (so re-init starts cold).
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

/** Test-only — clears the resolved config so each test starts cold. */
export function __resetConfig(): void {
  current = null
}
