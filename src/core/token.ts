import { SDK_CLIENT_HEADER } from '../version'
import { getConfig } from './config'

/**
 * Minimum seconds remaining before we trigger a refresh of the cached token.
 * Refreshing at 30s before expiry gives the network plenty of headroom.
 */
const REFRESH_BUFFER_MS = 30_000

interface CachedToken {
  token: string
  expiresAtMs: number
}

let cached: CachedToken | null = null
let inflight: Promise<string> | null = null

/**
 * Decode the `exp` claim from a JWT (no signature verification — that's the
 * server's job). Returns the expiry as a Unix-ms timestamp, or null if the
 * token is malformed / lacks an exp claim.
 */
export function decodeJwtExp(token: string): number | null {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payloadRaw = parts[1]!
    const padded =
      payloadRaw.replace(/-/g, '+').replace(/_/g, '/') +
      '==='.slice((payloadRaw.length + 3) % 4)
    const json =
      typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8')
    const payload = JSON.parse(json) as { exp?: number }
    if (typeof payload.exp !== 'number') return null
    return payload.exp * 1000
  } catch {
    return null
  }
}

function rememberToken(token: string): void {
  const expMs = decodeJwtExp(token)
  // If we can't read an exp claim, default to 10 minutes from now.
  const expiresAtMs = expMs ?? Date.now() + 10 * 60 * 1000
  cached = { token, expiresAtMs }
}

function isFresh(entry: CachedToken | null): entry is CachedToken {
  if (!entry) return false
  return entry.expiresAtMs - Date.now() > REFRESH_BUFFER_MS
}

/**
 * Mint a sessionToken via the customer-supplied `unsafe` credentials. This
 * is the ESCAPE HATCH path — strongly discouraged for browser apps.
 */
async function mintViaUnsafe(): Promise<string> {
  const cfg = getConfig()
  if (!cfg.unsafe?.directClientId || !cfg.unsafe.directClientSecret) {
    throw new Error('[QuickAuth] unsafe credentials missing')
  }
  const res = await cfg.fetchImpl(`${cfg.apiBaseUrl}/v1/sdk/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': cfg.unsafe.directClientId,
      'X-Client-Secret': cfg.unsafe.directClientSecret,
      'X-QA-SDK': SDK_CLIENT_HEADER,
    },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    throw new Error(
      `[QuickAuth] /v1/sdk/session failed with ${res.status}`,
    )
  }
  const body = (await res.json()) as { sessionToken?: string; token?: string }
  const token = body.sessionToken ?? body.token
  if (!token) {
    throw new Error('[QuickAuth] /v1/sdk/session response missing sessionToken')
  }
  return token
}

async function refresh(): Promise<string> {
  const cfg = getConfig()
  if (cfg.onTokenExpiry) {
    const token = await cfg.onTokenExpiry()
    if (typeof token !== 'string' || !token) {
      throw new Error('[QuickAuth] onTokenExpiry must return a non-empty token')
    }
    return token
  }
  if (cfg.unsafe) {
    return mintViaUnsafe()
  }
  throw new Error(
    '[QuickAuth] no onTokenExpiry callback or unsafe credentials configured',
  )
}

/**
 * Returns a fresh sessionToken, refreshing through the configured callback
 * (or unsafe-mode mint) if cached token is missing / expiring soon.
 *
 * Single-flight: concurrent callers share a single in-flight refresh.
 */
export async function getToken(): Promise<string> {
  // Lazily seed cache from initialToken on first call.
  if (!cached) {
    const cfg = getConfig()
    if (cfg.initialToken) {
      rememberToken(cfg.initialToken)
    }
  }

  if (isFresh(cached)) {
    return cached.token
  }

  if (inflight) return inflight

  inflight = (async () => {
    try {
      const token = await refresh()
      rememberToken(token)
      return token
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** Drop the cached token. The next `getToken()` call will refresh. */
export function invalidate(): void {
  cached = null
}

/** Test-only — drops both cache and in-flight refresh. */
export function __resetTokenManager(): void {
  cached = null
  inflight = null
}

export const tokenManager = {
  getToken,
  invalidate,
}
