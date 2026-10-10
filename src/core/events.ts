import type { AuthEvent, AuthEventHandler } from '../types'
import { logger } from './logger'

let handler: AuthEventHandler | null = null

export function setAuthEventHandler(h: AuthEventHandler | null): void {
  handler = h
}

export function emitAuthEvent(event: AuthEvent): void {
  logger.debug(`event ${event.type}`, event.type === 'OTP_AUTO_READ' ? { ...event, code: '******' } : event)
  const h = handler
  if (!h) return
  queueMicrotask(() => {
    try {
      h(event)
    } catch (err) {
      logger.error('onAuthEvent handler threw:', err)
    }
  })
}

export function __resetAuthEvents(): void {
  handler = null
}
