import { captureDeviceInfo } from '../attribution/device'
import { post } from '../core/client'
import { toErrorEvent } from '../core/errors'
import { consent } from '../core/consent'
import { emitAuthEvent } from '../core/events'
import { storage } from '../core/storage'
import type { InitiateOptions, OTPChannel, ResetOptions } from '../types'
import { addListener, armWebOTP, deliverCode } from './webotp'

const E164 = /^\+[1-9]\d{6,14}$/
const DEVICE_TOKEN_KEY = 'device_token'
const OTP_CODE_RE = /^\d{4,8}$/
const DEFAULT_EXPIRES_IN_S = 300

type SessionState =
  | { kind: 'idle' }
  | { kind: 'sending'; attemptId: number }
  | { kind: 'awaiting_otp'; attemptId: number; sessionId: string }
  | { kind: 'verifying'; attemptId: number; sessionId: string }
  | { kind: 'verified'; attemptId: number; requestId: string }
  | { kind: 'failed'; attemptId: number }

let state: SessionState = { kind: 'idle' }
let attemptCounter = 0

let activePhone: string | null = null
let activeChannel: OTPChannel = 'auto'
let autoSubmitEnabled = false
let autoSubmitted = false
let autoReadDispose: (() => void) | null = null

interface BackendInitiateResponse {
  state?: 'OTP_SENT' | 'VERIFIED'
  sessionId: string
  expiresIn?: number
  deviceToken?: string
}

interface BackendVerifyResponse {
  state?: 'VERIFIED' | 'OTP_FAILED'
  verified?: boolean
  requestId: string
  message: string
}

async function withDeviceFields(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stored = storage.get<string>(DEVICE_TOKEN_KEY)
  if (stored) body.deviceToken = stored
  if (consent.get()) {
    try {
      body.deviceInfo = await captureDeviceInfo()
    } catch {
      // ignore
    }
  }
  return body
}

export async function initiate(opts: InitiateOptions): Promise<void> {
  const phone = typeof opts?.phone === 'string' ? opts.phone.trim() : ''
  if (!E164.test(phone)) {
    throw new Error(
      '[QuickAuth] initiate: phone must be E.164 formatted (e.g. +919876543210)',
    )
  }
  const channel: OTPChannel = opts.channel ?? 'auto'
  const autoSubmit = opts.autoSubmit === true
  const attemptId = ++attemptCounter
  state = { kind: 'sending', attemptId }

  activePhone = phone
  activeChannel = channel
  autoSubmitEnabled = autoSubmit
  autoSubmitted = false

  armAutoRead(attemptId)

  const body = await withDeviceFields({ phone, channel })

  let res: BackendInitiateResponse
  try {
    res = await post<BackendInitiateResponse>('/v1/sdk/auth/initiate', body, { validate: checkInitiate })
  } catch (err) {
    if (state.kind === 'sending' && state.attemptId === attemptId) {
      state = { kind: 'failed', attemptId }
      emitAuthEvent(toErrorEvent(err))
    }
    throw err
  }

  if (state.kind !== 'sending' || state.attemptId !== attemptId) return

  if (res.deviceToken) storage.set(DEVICE_TOKEN_KEY, res.deviceToken)

  if (res.state === 'VERIFIED') {
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
    expiresIn: typeof res.expiresIn === 'number' ? res.expiresIn : DEFAULT_EXPIRES_IN_S,
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

  const body = await withDeviceFields({ sessionId, code })

  let res: BackendVerifyResponse
  try {
    res = await post<BackendVerifyResponse>('/v1/sdk/auth/verify', body, { validate: checkVerify })
  } catch (err) {
    if (state.kind === 'verifying' && state.attemptId === attemptId) {
      state = { kind: 'failed', attemptId }
      emitAuthEvent(toErrorEvent(err))
    }
    throw err
  }

  if (state.kind !== 'verifying' || state.attemptId !== attemptId) return

  const isVerified = res.state === 'VERIFIED' || (res.state == null && res.verified === true)
  if (isVerified) {
    disarmAutoRead()
    state = { kind: 'verified', attemptId, requestId: res.requestId }
    emitAuthEvent({
      type: 'VERIFIED',
      requestId: res.requestId,
      message: res.message,
    })
    return
  }

  state = { kind: 'awaiting_otp', attemptId, sessionId }
  emitAuthEvent({ type: 'OTP_FAILED', message: res.message || 'Incorrect code' })
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const asObject = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>

function checkInitiate(raw: unknown): string | null {
  return nonEmpty(asObject(raw).sessionId) ? null : 'missing sessionId'
}

function checkVerify(raw: unknown): string | null {
  const res = asObject(raw)
  if (res.state == null && typeof res.verified !== 'boolean') return 'missing state/requestId'
  const verified = res.state === 'VERIFIED' || (res.state == null && res.verified === true)
  return verified && !nonEmpty(res.requestId) ? 'missing state/requestId' : null
}

/** Send the code again, to the number the current attempt is already for. */
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

/** Feed a code in from outside the SDK — your own SMS webhook, a paste handler, a native shell's message listener. */
export function publishAutoReadCode(code: string): void {
  if (typeof code !== 'string' || !code) {
    throw new Error('[QuickAuth] publishAutoReadCode: code must be a non-empty string')
  }
  if (autoReadDispose) {
    deliverCode(code)
    return
  }
  emitAuthEvent({ type: 'OTP_AUTO_READ', code })
  deliverCode(code)
}

export function reset(opts?: ResetOptions): void {
  stopAutoRead()
  state = { kind: 'idle' }
  attemptCounter++
  if (opts?.forgetDevice) {
    storage.remove(DEVICE_TOKEN_KEY)
  }
}

function armAutoRead(attemptId: number): void {
  // Subscribe before dropping the previous attempt's listener, so a pending
  // WebOTP request is handed over instead of aborted and re-issued.
  const previous = autoReadDispose
  autoReadDispose = addListener({
    onCode: (code) => {
      if (state.kind === 'idle' || state.attemptId !== attemptId) return
      emitAuthEvent({ type: 'OTP_AUTO_READ', code })
      maybeAutoSubmit(code, attemptId)
    },
    onError: () => undefined,
  })
  previous?.()
  armWebOTP()
}

function disarmAutoRead(): void {
  autoReadDispose?.()
  autoReadDispose = null
}

function stopAutoRead(): void {
  disarmAutoRead()
  autoSubmitEnabled = false
  activePhone = null
}

function maybeAutoSubmit(code: string, attemptId: number): void {
  if (!autoSubmitEnabled || autoSubmitted) return
  if (state.kind !== 'awaiting_otp' || state.attemptId !== attemptId) return
  autoSubmitted = true
  void submitOtp(code).catch(() => undefined)
}

export function __getSessionState(): SessionState {
  return state
}

export function __resetSession(): void {
  stopAutoRead()
  autoSubmitted = false
  activeChannel = 'auto'
  state = { kind: 'idle' }
  attemptCounter = 0
}
