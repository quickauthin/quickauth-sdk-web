import { post } from '../core/client'
import type {
  OTPSession,
  StartOTPOptions,
  VerifyOTPOptions,
  VerifyOTPResult,
} from '../types'

const E164 = /^\+[1-9]\d{6,14}$/

export async function startOTP(opts: StartOTPOptions): Promise<OTPSession> {
  if (!opts || typeof opts.phone !== 'string' || !E164.test(opts.phone)) {
    throw new Error(
      '[QuickAuth] startOTP: phone must be E.164 formatted (e.g. +919876543210)',
    )
  }
  const channel = opts.channel ?? 'auto'
  return post<OTPSession>('/v1/sdk/auth/initiate', {
    phone: opts.phone,
    channel,
  })
}

export async function verifyOTP(
  opts: VerifyOTPOptions,
): Promise<VerifyOTPResult> {
  if (!opts?.sessionId) {
    throw new Error('[QuickAuth] verifyOTP: sessionId is required')
  }
  if (!opts.code || !/^\d{4,8}$/.test(opts.code)) {
    throw new Error('[QuickAuth] verifyOTP: code must be 4–8 digits')
  }
  return post<VerifyOTPResult>('/v1/sdk/auth/verify', {
    sessionId: opts.sessionId,
    code: opts.code,
  })
}
