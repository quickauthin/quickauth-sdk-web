import type { ResolvedConfig } from './config'
import { QuickAuthError } from './errors'

export interface FetchedResponse {
  res: Response
  /** The full response body. */
  text: string
}

/**
 * `fetch` plus reading the body, both under the configured timeout — a server that
 * sends headers and then stalls still times out. Transport failures become
 * `TIMEOUT` / `NETWORK_ERROR`.
 */
export async function fetchWithTimeout(
  cfg: Pick<ResolvedConfig, 'fetchImpl' | 'requestTimeoutMs'>,
  url: string,
  init: RequestInit,
  outer?: AbortSignal,
): Promise<FetchedResponse> {
  const ctrl = new AbortController()
  let timedOut = false
  const ms = cfg.requestTimeoutMs
  const timer =
    ms > 0
      ? setTimeout(() => {
          timedOut = true
          ctrl.abort()
        }, ms)
      : undefined
  const onOuterAbort = () => ctrl.abort()
  if (outer) {
    if (outer.aborted) ctrl.abort()
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }
  let res: Response | undefined
  try {
    res = await cfg.fetchImpl(url, { ...init, signal: ctrl.signal })
    const text = await readBody(res, ctrl.signal)
    return { res, text }
  } catch (err) {
    if (timedOut) {
      throw new QuickAuthError(
        `[QuickAuth] Request timed out after ${ms / 1000}s${res ? ' — the server stopped responding mid-response' : ''}`,
        res?.status,
        undefined,
        { code: 'TIMEOUT' },
      )
    }
    if (outer?.aborted) throw err
    const detail = err instanceof Error ? err.message : String(err)
    if (res) {
      throw new QuickAuthError(
        `[QuickAuth] Network error — the connection dropped while reading the response: ${detail}`,
        res.status,
        undefined,
        { code: 'NETWORK_ERROR' },
      )
    }
    throw new QuickAuthError(
      `[QuickAuth] Network error (offline, or blocked by CORS — is this site in Allowed Origins?): ${detail}`,
      undefined,
      undefined,
      { code: 'NETWORK_ERROR' },
    )
  } finally {
    if (timer) clearTimeout(timer)
    outer?.removeEventListener('abort', onOuterAbort)
  }
}

/** `res.text()` that also gives up when `signal` aborts — not every fetch implementation ties the body stream to the signal. */
function readBody(res: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    res.text().then(
      (t) => {
        signal.removeEventListener('abort', onAbort)
        resolve(t)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}
