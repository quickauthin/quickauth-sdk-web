/**
 * Headless auth state machine.
 *
 * Public API:
 *   QuickAuth.auth.initiate({ phone, channel })
 *   QuickAuth.auth.submitOtp(code)
 *   QuickAuth.auth.reset({ forgetDevice })
 *
 * All outcomes are delivered via the {@code onAuthEvent} handler registered
 * at init time. The promises returned by these three methods only resolve
 * once the network call has completed (or reject if the request couldn't
 * be dispatched at all). Merchants should treat events as the source of
 * truth for what UI to render.
 *
 * State machine:
 *   idle ──initiate()──► sending ──OTP_SENT───► awaiting_otp ──submitOtp()──► verifying
 *                              └──VERIFIED────► verified                              │
 *                              └──error───────► failed                                │
 *   verifying ──VERIFIED────► verified                                                │
 *   verifying ──OTP_FAILED──► awaiting_otp ◄────────────────────────────────────────┘
 *   any state ──reset()─────► idle
 *
 * Concurrent {@code initiate()} calls follow latest-wins semantics: the
 * earlier attempt's session is dropped and any late events from it are
 * suppressed by attempt-id matching.
 */

import { collectDeviceInfo } from '../attribution/device'
import { post } from '../core/client'
import { consent } from '../core/consent'
import { emitAuthEvent } from '../core/events'
import { storage } from '../core/storage'
import type { InitiateOptions, OTPChannel, ResetOptions } from '../types'

const E164 = /^\+[1-9]\d{6,14}$/
const DEVICE_TOKEN_KEY = 'device_token'
const OTP_CODE_RE = /^\d{4,8}$/

type SessionState =
  | { kind: 'idle' }
  | { kind: 'sending'; attemptId: number }
  | { kind: 'awaiting_otp'; attemptId: number; sessionId: string }
  | { kind: 'verifying'; attemptId: number; sessionId: string }
  | { kind: 'verified'; attemptId: number; requestId: string }
  | { kind: 'failed'; attemptId: number }

let state: SessionState = { kind: 'idle' }
let attemptCounter = 0

interface BackendInitiateResponse {
  state: 'OTP_SENT' | 'VERIFIED'
  sessionId: string
  expiresIn: number
  deviceToken?: string
}

interface BackendVerifyResponse {
  state: 'VERIFIED' | 'OTP_FAILED'
  verified: boolean // legacy alias, ignored — we trust `state`
  requestId: string
  message: string
}

function withDeviceFields(body: Record<string, unknown>): Record<string, unknown> {
  const stored = storage.get<string>(DEVICE_TOKEN_KEY)
  if (stored) body.deviceToken = stored
  if (consent.get()) {
    try {
      body.deviceInfo = collectDeviceInfo()
    } catch {
      // deviceInfo is purely informational
    }
  }
  return body
}

export async function initiate(opts: InitiateOptions): Promise<void> {
  if (!opts || typeof opts.phone !== 'string' || !E164.test(opts.phone)) {
    throw new Error(
      '[QuickAuth] initiate: phone must be E.164 formatted (e.g. +919876543210)',
    )
  }
  const channel: OTPChannel = opts.channel ?? 'auto'
  const attemptId = ++attemptCounter
  state = { kind: 'sending', attemptId }

  const body = withDeviceFields({ phone: opts.phone, channel })

  let res: BackendInitiateResponse
  try {
    res = await post<BackendInitiateResponse>('/v1/sdk/auth/initiate', body)
  } catch (err) {
    // Only emit ERROR if this attempt is still the current one — guards
    // against a stale rejection arriving after the merchant kicked off a
    // newer attempt.
    if (state.kind === 'sending' && state.attemptId === attemptId) {
      state = { kind: 'failed', attemptId }
      emitAuthEvent({
        type: 'ERROR',
        code: classifyError(err),
        message: errorMessage(err),
      })
    }
    throw err
  }

  // Late response from a superseded attempt — drop it on the floor.
  if (state.kind !== 'sending' || state.attemptId !== attemptId) return

  if (res.deviceToken) storage.set(DEVICE_TOKEN_KEY, res.deviceToken)

  if (res.state === 'VERIFIED') {
    state = { kind: 'verified', attemptId, requestId: res.sessionId }
    emitAuthEvent({ type: 'VERIFIED', requestId: res.sessionId })
    return
  }

  state = { kind: 'awaiting_otp', attemptId, sessionId: res.sessionId }
  emitAuthEvent({
    type: 'OTP_SENT',
    sessionId: res.sessionId,
    channel,
    expiresIn: res.expiresIn,
  })
}

export async function submitOtp(code: string): Promise<void> {
  if (typeof code !== 'string' || !OTP_CODE_RE.test(code)) {
    throw new Error('[QuickAuth] submitOtp: code must be 4–8 digits')
  }
  if (state.kind !== 'awaiting_otp') {
    throw new Error(
      `[QuickAuth] submitOtp called in state "${state.kind}" — must follow an OTP_SENT event`,
    )
  }
  const { attemptId, sessionId } = state
  state = { kind: 'verifying', attemptId, sessionId }

  const body = withDeviceFields({ sessionId, code })

  let res: BackendVerifyResponse
  try {
    res = await post<BackendVerifyResponse>('/v1/sdk/auth/verify', body)
  } catch (err) {
    if (state.kind === 'verifying' && state.attemptId === attemptId) {
      state = { kind: 'failed', attemptId }
      emitAuthEvent({
        type: 'ERROR',
        code: classifyError(err),
        message: errorMessage(err),
      })
    }
    throw err
  }

  if (state.kind !== 'verifying' || state.attemptId !== attemptId) return

  if (res.state === 'VERIFIED') {
    state = { kind: 'verified', attemptId, requestId: res.requestId }
    emitAuthEvent({
      type: 'VERIFIED',
      requestId: res.requestId,
      message: res.message,
    })
    return
  }

  // OTP_FAILED — stay in awaiting_otp so merchant can retry.
  state = { kind: 'awaiting_otp', attemptId, sessionId }
  emitAuthEvent({ type: 'OTP_FAILED', message: res.message })
}

export function reset(opts?: ResetOptions): void {
  state = { kind: 'idle' }
  attemptCounter++
  if (opts?.forgetDevice) {
    storage.remove(DEVICE_TOKEN_KEY)
  }
}

/** Test-only — exposes internal state for assertions. */
export function __getSessionState(): SessionState {
  return state
}

/** Test-only — fully resets state and attempt counter. */
export function __resetSession(): void {
  state = { kind: 'idle' }
  attemptCounter = 0
}

function classifyError(err: unknown): string {
  const e = err as { code?: string; status?: number }
  if (typeof e?.code === 'string') return e.code
  if (typeof e?.status === 'number') {
    if (e.status === 429) return 'RATE_LIMITED'
    if (e.status >= 500) return 'SERVER_ERROR'
    if (e.status >= 400) return 'CLIENT_ERROR'
  }
  return 'UNKNOWN_ERROR'
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string }
  return typeof e?.message === 'string' ? e.message : 'Request failed'
}
