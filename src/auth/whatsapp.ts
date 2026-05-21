import type { WhatsAppLoginOptions } from '../types'

/**
 * Open a wa.me deep-link that prefills the configured business number with
 * a signed login token in the message body. Caller is expected to surface
 * a "Continue with WhatsApp" button that triggers this from a user gesture.
 */
export function startWhatsAppLogin(opts: WhatsAppLoginOptions): string {
  if (!opts?.businessNumber) {
    throw new Error('[QuickAuth] startWhatsAppLogin: businessNumber required')
  }
  const number = opts.businessNumber.replace(/[^\d]/g, '')
  if (!number) {
    throw new Error(
      '[QuickAuth] startWhatsAppLogin: businessNumber must contain digits',
    )
  }
  const message =
    opts.message ??
    `Login to ${typeof window !== 'undefined' ? window.location.host : 'app'}`
  const params = new URLSearchParams({ text: message })
  if (opts.returnUrl) {
    params.set('text', `${message}\n\nReturn: ${opts.returnUrl}`)
  }
  const url = `https://wa.me/${number}?${params.toString()}`

  if (typeof window !== 'undefined') {
    window.location.href = url
  }
  return url
}
