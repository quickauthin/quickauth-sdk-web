/**
 * Tiny single-subscriber event bus for auth lifecycle events.
 *
 * QuickAuth's headless flow follows a one-callback model (mirrors OTPless,
 * matches what each native platform does naturally): the merchant registers
 * exactly one {@code onAuthEvent} at init time, and the SDK pushes typed
 * events into it as the lifecycle progresses.
 *
 * Multi-subscriber buses (EventTarget, EventEmitter) are deliberately not
 * used — they invite analytics / UI / logging to attach in random places
 * and obscure the single source of truth for "what should the screen show?".
 * Merchants who want fan-out should do it inside their own handler.
 *
 * Dispatch is microtask-deferred so callers can safely write
 * {@code await initiate(); doNextThing()} without racing the event
 * for the same call.
 */

import type { AuthEvent, AuthEventHandler } from '../types'

let handler: AuthEventHandler | null = null

export function setAuthEventHandler(h: AuthEventHandler | null): void {
  handler = h
}

export function emitAuthEvent(event: AuthEvent): void {
  const h = handler
  if (!h) return
  // Microtask defer: keeps event delivery off the synchronous resolution
  // path of the initiate/submitOtp promise, so merchants can rely on
  // "events fire after my await resumes".
  queueMicrotask(() => {
    try {
      h(event)
    } catch (err) {
      // Never let a merchant's handler crash the SDK.
      if (typeof console !== 'undefined') {
        console.error('[QuickAuth] onAuthEvent handler threw:', err)
      }
    }
  })
}

/** Test-only — clears the registered handler so each test starts cold. */
export function __resetAuthEvents(): void {
  handler = null
}
