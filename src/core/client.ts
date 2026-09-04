import type { QueuedRequest } from '../types'
import { SDK_CLIENT_HEADER } from '../version'
import { getConfig } from './config'
import { consent } from './consent'
import { storage } from './storage'
import { getToken, invalidate as invalidateToken } from './token'

const QUEUE_KEY = 'offline_queue'

export class QuickAuthError extends Error {
  status?: number
  body?: unknown
  constructor(message: string, status?: number, body?: unknown) {
    super(message)
    this.name = 'QuickAuthError'
    this.status = status
    this.body = body
  }
}

export interface PostOptions {
  /**
   * If true, request is silently queued in localStorage when consent=false
   * and replayed when consent flips to true. Used for tracking endpoints.
   */
  consentGated?: boolean
  /** Override the default Idempotency-Key. */
  idempotencyKey?: string
  /** AbortSignal for the underlying fetch. */
  signal?: AbortSignal
}

function uuid(): string {
  // Prefer the native crypto helper; fall back to a sufficiently-random hex.
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

async function rawPost<T>(
  url: string,
  body: unknown,
  options: PostOptions = {},
): Promise<T> {
  const cfg = getConfig()
  const idempotencyKey = options.idempotencyKey ?? uuid()
  let lastError: unknown
  // Track whether we've already retried after a 401-driven token refresh, so
  // we don't loop forever when the server keeps rejecting the token.
  let didRetryAfter401 = false

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const token = await getToken()
      const res = await cfg.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
          'X-QA-SDK': SDK_CLIENT_HEADER,
        },
        body: JSON.stringify(body ?? {}),
        signal: options.signal,
      })

      if (res.status === 401 && !didRetryAfter401) {
        // Token rejected — invalidate cache, refresh, and try once more.
        didRetryAfter401 = true
        invalidateToken()
        // Re-run this attempt without consuming a retry slot.
        attempt--
        continue
      }

      if (res.status >= 500 && attempt < cfg.maxRetries) {
        lastError = new QuickAuthError(`Server error ${res.status}`, res.status)
        await sleep(2 ** attempt * 200)
        continue
      }

      const text = await res.text()
      const parsed = text ? safeJson(text) : null

      if (!res.ok) {
        throw new QuickAuthError(
          `QuickAuth API ${res.status}`,
          res.status,
          parsed,
        )
      }

      return parsed as T
    } catch (err) {
      // Network errors look like TypeError / AbortError. Retry network/5xx only.
      lastError = err
      if (err instanceof QuickAuthError && err.status && err.status < 500) {
        throw err
      }
      if (attempt >= cfg.maxRetries) break
      await sleep(2 ** attempt * 200)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new QuickAuthError('QuickAuth request failed')
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** POST helper used by every endpoint. */
export async function post<T>(
  path: string,
  body: unknown,
  options: PostOptions = {},
): Promise<T> {
  const cfg = getConfig()
  const url = path.startsWith('http') ? path : cfg.apiBaseUrl + path

  if (options.consentGated && !consent.get()) {
    enqueue({
      id: uuid(),
      url,
      body,
      createdAt: Date.now(),
      attempts: 0,
    })
    // We deliberately resolve undefined — caller knows tracking is queued.
    return undefined as unknown as T
  }

  return rawPost<T>(url, body, options)
}

function enqueue(req: QueuedRequest): void {
  const queue = storage.get<QueuedRequest[]>(QUEUE_KEY) ?? []
  queue.push(req)
  // Cap to last 50 to avoid runaway storage usage.
  while (queue.length > 50) queue.shift()
  storage.set(QUEUE_KEY, queue)
}

/** Replay every queued request. Called when consent flips to true / on init. */
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
      // Re-queue on failure (preserve original id for idempotency).
      remaining.push({ ...item, attempts: item.attempts + 1 })
    }
  }
  if (remaining.length) storage.set(QUEUE_KEY, remaining)
}

/** Drop everything queued — used when the user revokes consent. */
export function clearQueue(): void {
  storage.remove(QUEUE_KEY)
}

export const __test = { uuid, rawPost }
