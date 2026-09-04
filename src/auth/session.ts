/**
 * Headless auth state machine.
 *
 * Public API:
 *   QuickAuth.auth.initiate({ phone, channel, autoSubmit })
 *   QuickAuth.auth.submitOtp(code)
 *   QuickAuth.auth.resendOtp()
 *   QuickAuth.auth.publishAutoReadCode(code)
 *   QuickAuth.auth.reset({ forgetDevice })
 *
 * All outcomes are delivered via the {@code onAuthEvent} handler registered
 * at init time. The promises returned by these methods only resolve once the
 * network call has completed (or reject if the request couldn't be dispatched
 * at all). Merchants should treat events as the source of truth for what UI
 * to render.
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
import { addListener, armWebOTP, deliverCode } from './webotp'

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

/**
 * The phone and options of the live attempt, so {@link resendOtp} needs no
 * arguments. A merchant should not have to hold the number themselves to
 * resend to it — they already gave it to us, and asking for it again is an
 * opportunity to pass a different one by accident, which would start a second
 * transaction and leave the user holding two codes, only one of which works.
 */
let activePhone: string | null = null
let activeChannel: OTPChannel = 'auto'

/** Whether the current attempt should verify an auto-read code by itself. */
let autoSubmitEnabled = false

/**
 * One auto-submit per attempt. WebOTP can deliver, the merchant can feed a
 * code in through {@link publishAutoReadCode}, and a merchant on the `auto`
 * channel may receive both an SMS and a WhatsApp copy of the same code.
 * Submitting the second would verify a code the server has already consumed,
 * which surfaces to the user as a failure arriving after a success.
 */
let autoSubmitted = false

/** Disposer for this attempt's WebOTP listener; null when nothing is armed. */
let autoReadDispose: (() => void) | null = null

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
  const autoSubmit = opts.autoSubmit === true
  const attemptId = ++attemptCounter
  state = { kind: 'sending', attemptId }

  // Remember what this attempt is for BEFORE the network call, so a resend
  // works even when the send failed — that is exactly when a user taps it.
  activePhone = opts.phone
  activeChannel = channel
  autoSubmitEnabled = autoSubmit
  autoSubmitted = false

  // Arm auto-read ourselves. A caller who never touches observeOTP must still
  // get OTP_AUTO_READ events and autoSubmit — the merchant was told they need
  // not subscribe to anything, so leaving the arming to observeOTP meant
  // autoSubmit silently did nothing in precisely the integration it was for.
  // Re-armed per attempt: WebOTP requests are single-shot, so the previous
  // attempt's request is spent (or about to be superseded) and must go.
  armAutoRead(attemptId)

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
    // OneTap fired: no code is coming, so drop the WebOTP request rather than
    // leaving the browser's "use the code from SMS" prompt hanging over an
    // already-logged-in user.
    disarmAutoRead()
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
    disarmAutoRead()
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

/**
 * Send the code again, to the number the current attempt is already for.
 *
 * Within the merchant's expiry window the server returns the SAME code and
 * pushes the expiry forward, so a user who missed the first message gets that
 * message again rather than a second code to choose between. Past the window
 * it issues a fresh one, which is what an expired code deserves.
 *
 * Takes no arguments deliberately — see {@link activePhone}. It carries the
 * original attempt's channel and `autoSubmit` setting, so a resend behaves
 * like the request it repeats rather than silently reverting to defaults.
 *
 * Rejects when there is no attempt to resend. That is a programming error
 * rather than a runtime condition: a resend button should only exist once a
 * code has been sent.
 */
export function resendOtp(): Promise<void> {
  const phone = activePhone
  if (!phone) {
    return Promise.reject(
      new Error('[QuickAuth] resendOtp: nothing to resend — call initiate() first.'),
    )
  }
  return initiate({
    phone,
    channel: activeChannel,
    autoSubmit: autoSubmitEnabled,
  })
}

/**
 * Feed a code in from outside the SDK — your own SMS webhook, a paste
 * handler, a native shell's message listener.
 *
 * Behaves exactly as if WebOTP had read it: emits `OTP_AUTO_READ`, hands the
 * code to any `observeOTP` subscribers, and auto-submits when the current
 * attempt asked for it (once — the same one-shot latch applies).
 */
export function publishAutoReadCode(code: string): void {
  if (typeof code !== 'string' || !code) {
    throw new Error('[QuickAuth] publishAutoReadCode: code must be a non-empty string')
  }
  if (autoReadDispose) {
    // An attempt is armed, so its listener is registered with the WebOTP hub:
    // publishing through the hub emits OTP_AUTO_READ exactly once and honours
    // the auto-submit latch, and observeOTP subscribers get the code too.
    deliverCode(code)
    return
  }
  // No live attempt — nothing is registered to emit on our behalf, and there
  // is nothing to auto-submit against.
  emitAuthEvent({ type: 'OTP_AUTO_READ', code })
  deliverCode(code)
}

export function reset(opts?: ResetOptions): void {
  stopAutoRead()
  state = { kind: 'idle' }
  attemptCounter++ // invalidate any in-flight attempt
  if (opts?.forgetDevice) {
    storage.remove(DEVICE_TOKEN_KEY)
  }
}

/**
 * Subscribe to the WebOTP hub on the caller's behalf for this attempt, then
 * (re)start the underlying single-shot request.
 */
function armAutoRead(attemptId: number): void {
  autoReadDispose?.()
  autoReadDispose = addListener({
    onCode: (code) => {
      // A code that outlived its attempt would verify against a session the
      // user has already restarted, and fail for reasons they cannot see.
      if (state.kind === 'idle' || state.attemptId !== attemptId) return
      emitAuthEvent({ type: 'OTP_AUTO_READ', code })
      maybeAutoSubmit(code, attemptId)
    },
    // A platform-side failure must not take down the OTP flow — the user can
    // still type the code in.
    onError: () => undefined,
  })
  armWebOTP()
}

/**
 * Drop this attempt's WebOTP subscription (and the underlying request, if
 * nothing else is listening). Safe to call twice.
 */
function disarmAutoRead(): void {
  autoReadDispose?.()
  autoReadDispose = null
}

/** End the attempt entirely: stop auto-read and forget what it was for. */
function stopAutoRead(): void {
  disarmAutoRead()
  autoSubmitEnabled = false
  // Nothing left to resend to: a reset ends the attempt, and resending
  // afterwards would message someone who is no longer mid-login.
  activePhone = null
}

function maybeAutoSubmit(code: string, attemptId: number): void {
  if (!autoSubmitEnabled || autoSubmitted) return
  // Only submit from the state that accepts a code. A code arriving before
  // OTP_SENT (or after the attempt already resolved) does not burn the latch —
  // it just isn't submittable yet, and burning it there would disable
  // auto-submit for the code that actually can be.
  if (state.kind !== 'awaiting_otp' || state.attemptId !== attemptId) return
  autoSubmitted = true
  // Outcomes arrive as events; the rejection is the same failure already
  // reported through them, so swallow it rather than leaving an unhandled
  // rejection in the merchant's console.
  void submitOtp(code).catch(() => undefined)
}

/** Test-only — exposes internal state for assertions. */
export function __getSessionState(): SessionState {
  return state
}

/** Test-only — fully resets state and attempt counter. */
export function __resetSession(): void {
  stopAutoRead()
  autoSubmitted = false
  activeChannel = 'auto'
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
