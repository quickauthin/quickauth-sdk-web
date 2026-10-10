import type { AuthEvent, QuickAuthErrorCode } from '../types'

export interface QuickAuthErrorDetails {
  code?: QuickAuthErrorCode
  errorCode?: string
  retryAfter?: number
  requestId?: string
}

/** Error thrown for every failed API call, with the server's reason attached. */
export class QuickAuthError extends Error {
  /** SDK category, e.g. `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`. */
  code: QuickAuthErrorCode
  /** HTTP status, when the server answered. */
  status?: number
  /** Parsed response body, when the server answered. */
  body?: unknown
  /** The server's machine-readable reason, e.g. `INVALID_REQUEST`. */
  errorCode?: string
  /** Seconds to wait before retrying, from `Retry-After` or the response body. */
  retryAfter?: number
  /** The server's request id, for support tickets. */
  requestId?: string

  constructor(message: string, status?: number, body?: unknown, details: QuickAuthErrorDetails = {}) {
    super(message)
    this.name = 'QuickAuthError'
    this.status = status
    this.body = body
    this.code = details.code ?? codeForStatus(status)
    if (details.errorCode) this.errorCode = details.errorCode
    if (typeof details.retryAfter === 'number') this.retryAfter = details.retryAfter
    if (details.requestId) this.requestId = details.requestId
  }
}

export function codeForStatus(status?: number): QuickAuthErrorCode {
  if (typeof status !== 'number') return 'UNKNOWN_ERROR'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'SERVER_ERROR'
  if (status >= 400) return 'CLIENT_ERROR'
  return 'UNKNOWN_ERROR'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function parseRetryAfter(res: Response, body: Record<string, unknown>): number | undefined {
  for (const key of ['retryAfter', 'retryAfterSeconds', 'retry_after']) {
    const v = body[key]
    if (typeof v === 'number' && v >= 0) return Math.ceil(v)
  }
  const header = res.headers?.get?.('retry-after')
  if (!header) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs)
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/** Build the error for a non-2xx response, keeping the server's message and codes. */
export function httpError(res: Response, parsed: unknown): QuickAuthError {
  const b = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const serverMessage =
    str(b.message) ?? str(b.error) ?? (typeof parsed === 'string' && parsed.length < 200 ? parsed.trim() : undefined)
  return new QuickAuthError(
    `[QuickAuth] HTTP ${res.status}${serverMessage ? `: ${serverMessage}` : ''}`,
    res.status,
    parsed,
    {
      errorCode: str(b.errorCode) ?? str(b.code),
      retryAfter: res.status === 429 || res.status === 503 ? parseRetryAfter(res, b) : undefined,
      requestId: str(b.requestId) ?? res.headers?.get?.('x-request-id') ?? undefined,
    },
  )
}

/** Re-label any failure to obtain a session token as `TOKEN_ERROR`. */
export function tokenError(err: unknown): QuickAuthError {
  if (err instanceof QuickAuthError && err.code === 'TOKEN_ERROR') return err
  const detail = err instanceof Error ? err.message.replace(/^\[QuickAuth\]\s*/, '') : String(err)
  const qa = err instanceof QuickAuthError ? err : undefined
  return new QuickAuthError(`[QuickAuth] Could not get a session token: ${detail}`, qa?.status, qa?.body, {
    code: 'TOKEN_ERROR',
    errorCode: qa?.errorCode,
    requestId: qa?.requestId,
  })
}

/** The `ERROR` auth event for a failure. */
export function toErrorEvent(err: unknown): Extract<AuthEvent, { type: 'ERROR' }> {
  const e = err as Partial<QuickAuthError>
  const event: Extract<AuthEvent, { type: 'ERROR' }> = {
    type: 'ERROR',
    code: err instanceof QuickAuthError ? err.code : codeForStatus(e?.status),
    message: typeof e?.message === 'string' ? e.message : 'Request failed',
  }
  if (typeof e?.errorCode === 'string') event.errorCode = e.errorCode
  if (typeof e?.status === 'number') event.status = e.status
  if (typeof e?.retryAfter === 'number') event.retryAfter = e.retryAfter
  if (typeof e?.requestId === 'string') event.requestId = e.requestId
  return event
}
