import type { QueuedRequest } from '../types'
import { getConfig } from './config'
import { consent } from './consent'
import { QuickAuthError, httpError, tokenError } from './errors'
import { fetchWithTimeout } from './http'
import { logger, redact } from './logger'
import { storage } from './storage'
import { getToken, invalidate as invalidateToken } from './token'

export { QuickAuthError }

const QUEUE_KEY = 'offline_queue'

export interface PostOptions {
  consentGated?: boolean
  idempotencyKey?: string
  /** AbortSignal for the underlying fetch. */
  signal?: AbortSignal
  /** Checks a 2xx body; returns why it is unusable, or null. */
  validate?: (body: unknown) => string | null
}

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(16)
    c.getRandomValues(buf)
    buf[6] = ((buf[6] ?? 0) & 0x0f) | 0x40
    buf[8] = ((buf[8] ?? 0) & 0x3f) | 0x80
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`
  }
  return 'xxxxxxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const bare = (m: string) => m.replace(/^\[QuickAuth\]\s*/, '')

function backoffMs(attempt: number): number {
  return 2 ** attempt * 200
}

async function rawPost<T>(
  url: string,
  body: unknown,
  options: PostOptions = {},
): Promise<T> {
  const cfg = getConfig()
  const idempotencyKey = options.idempotencyKey ?? uuid()
  const path = url.startsWith(cfg.apiBaseUrl) ? url.slice(cfg.apiBaseUrl.length) : url
  let lastError: unknown
  let didRetryAfter401 = false

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    let authHeader: Record<string, string>
    if (cfg.publishableKey) {
      authHeader = { 'X-QuickAuth-Key': cfg.publishableKey }
    } else {
      try {
        authHeader = { Authorization: `Bearer ${await getToken()}` }
      } catch (err) {
        const e = tokenError(err)
        logger.debug(`✗ POST ${path} — ${bare(e.message)}`)
        throw e
      }
    }

    logger.debug(`→ POST ${path}${attempt ? ` (retry ${attempt})` : ''}`, redact(body))
    const t0 = Date.now()
    let res: Response
    let text: string
    try {
      ;({ res, text } = await fetchWithTimeout(
        cfg,
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeader,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body ?? {}),
        },
        options.signal,
      ))
    } catch (err) {
      if (options.signal?.aborted) throw err
      lastError = err
      logger.debug(`✗ POST ${path} — ${bare((err as Error).message)}`)
      if (attempt >= cfg.maxRetries) break
      await sleep(backoffMs(attempt))
      continue
    }

    const parsed = text ? safeJson(text) : null
    logger.debug(`← ${res.status} POST ${path} (${Date.now() - t0}ms)`, redact(parsed))

    if (res.status === 401 && !didRetryAfter401 && !cfg.publishableKey) {
      didRetryAfter401 = true
      invalidateToken()
      logger.debug('401 — refreshing the session token and retrying once')
      attempt--
      continue
    }

    if (res.ok) {
      if (typeof parsed === 'string') throw notJson(res, path)
      const problem = options.validate?.(parsed)
      if (problem) throw invalidResponse(`[QuickAuth] Invalid response from ${path}: ${problem}`, res, parsed)
      return parsed as T
    }

    const err = httpError(res, parsed)
    if (res.status >= 500 && attempt < cfg.maxRetries) {
      lastError = err
      await sleep(backoffMs(attempt))
      continue
    }
    throw err
  }

  throw lastError instanceof Error
    ? lastError
    : new QuickAuthError('[QuickAuth] Request failed', undefined, undefined, { code: 'UNKNOWN_ERROR' })
}

function notJson(res: Response, path: string): QuickAuthError {
  const type = (res.headers?.get?.('content-type') ?? 'unknown type').split(';')[0]
  return invalidResponse(
    `[QuickAuth] Unexpected response from the server (HTTP ${res.status}, ${type}) for ${path} — not the QuickAuth API. Check apiBaseUrl, or the network may be behind a login page (public Wi-Fi).`,
    res,
  )
}

/** A 2xx the SDK cannot use — `SERVER_ERROR` with `errorCode: 'INVALID_RESPONSE'`. */
function invalidResponse(message: string, res?: Response, body?: unknown): QuickAuthError {
  return new QuickAuthError(message, res?.status, body, {
    code: 'SERVER_ERROR',
    errorCode: 'INVALID_RESPONSE',
    requestId: res?.headers?.get?.('x-request-id') ?? undefined,
  })
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function post<T>(
  path: string,
  body: unknown,
  options: PostOptions = {},
): Promise<T> {
  const cfg = getConfig()
  const url = path.startsWith('http') ? path : cfg.apiBaseUrl + path

  if (options.consentGated && !consent.get()) {
    logger.debug(`queued until consent: POST ${path}`)
    enqueue({
      id: uuid(),
      url,
      body,
      createdAt: Date.now(),
      attempts: 0,
    })
    return undefined as unknown as T
  }

  return rawPost<T>(url, body, options)
}

function enqueue(req: QueuedRequest): void {
  const queue = storage.get<QueuedRequest[]>(QUEUE_KEY) ?? []
  queue.push(req)
  while (queue.length > 50) queue.shift()
  storage.set(QUEUE_KEY, queue)
}

/** Replay every queued request. */
export async function flushQueue(): Promise<void> {
  if (!consent.get()) return
  const queue = storage.get<QueuedRequest[]>(QUEUE_KEY) ?? []
  if (!queue.length) return
  storage.remove(QUEUE_KEY)

  const remaining: QueuedRequest[] = []
  for (const item of queue) {
    try {
      await rawPost(item.url, item.body, { idempotencyKey: item.id })
    } catch {
      remaining.push({ ...item, attempts: item.attempts + 1 })
    }
  }
  if (remaining.length) storage.set(QUEUE_KEY, remaining)
}

export function queueLength(): number {
  return storage.get<QueuedRequest[]>(QUEUE_KEY)?.length ?? 0
}

export function clearQueue(): void {
  storage.remove(QUEUE_KEY)
}

export const __test = { uuid, rawPost }
