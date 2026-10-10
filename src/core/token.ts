import { getConfig } from './config'
import { httpError } from './errors'
import { fetchWithTimeout } from './http'
import { logger } from './logger'

const REFRESH_BUFFER_MS = 30_000

interface CachedToken {
  token: string
  expiresAtMs: number
}

let cached: CachedToken | null = null
let inflight: Promise<string> | null = null

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
  const expiresAtMs = expMs ?? Date.now() + 10 * 60 * 1000
  cached = { token, expiresAtMs }
}

function isFresh(entry: CachedToken | null): entry is CachedToken {
  if (!entry) return false
  return entry.expiresAtMs - Date.now() > REFRESH_BUFFER_MS
}

async function mintViaUnsafe(): Promise<string> {
  const cfg = getConfig()
  if (!cfg.unsafe?.directClientId || !cfg.unsafe.directClientSecret) {
    throw new Error('[QuickAuth] unsafe credentials missing')
  }
  const { res, text } = await fetchWithTimeout(cfg, `${cfg.apiBaseUrl}/v1/sdk/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': cfg.unsafe.directClientId,
      'X-Client-Secret': cfg.unsafe.directClientSecret,
    },
    body: JSON.stringify({}),
  })
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    // ignore
  }
  if (!res.ok) throw httpError(res, body)
  const b = (body && typeof body === 'object' ? body : {}) as { sessionToken?: string; token?: string }
  const token = b.sessionToken ?? b.token
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
  if (cfg.publishableKey) {
    throw new Error('[QuickAuth] no session token in publishableKey mode')
  }
  throw new Error(
    '[QuickAuth] no onTokenExpiry callback or unsafe credentials configured',
  )
}

/** Returns a fresh sessionToken, refreshing through the configured callback (or unsafe-mode mint) if cached token is missing / expiring soon. */
export async function getToken(): Promise<string> {
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
      logger.debug(`refreshing session token via ${getConfig().onTokenExpiry ? 'onTokenExpiry' : 'unsafe credentials'}`)
      const token = await refresh()
      rememberToken(token)
      logger.debug(`session token ready, expires in ${Math.round((cached!.expiresAtMs - Date.now()) / 1000)}s`)
      return token
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** Drop the cached token. */
export function invalidate(): void {
  cached = null
}

export function __resetTokenManager(): void {
  cached = null
  inflight = null
}

export const tokenManager = {
  getToken,
  invalidate,
}
