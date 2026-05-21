import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeOTP } from '../src/auth/webotp'

describe('observeOTP', () => {
  const originalCreds = (navigator as unknown as { credentials?: unknown })
    .credentials
  const originalOTPCredential = (window as unknown as { OTPCredential?: unknown })
    .OTPCredential

  afterEach(() => {
    Object.defineProperty(navigator, 'credentials', {
      value: originalCreds,
      configurable: true,
    })
    if (originalOTPCredential === undefined) {
      delete (window as unknown as { OTPCredential?: unknown }).OTPCredential
    } else {
      ;(window as unknown as { OTPCredential?: unknown }).OTPCredential =
        originalOTPCredential
    }
  })

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('throws when onCode is missing', () => {
    expect(() =>
      // @ts-expect-error intentionally invalid
      observeOTP({}),
    ).toThrow(/onCode/)
  })

  it('falls back to autocomplete attribute on unsupported browsers', () => {
    delete (window as unknown as { OTPCredential?: unknown }).OTPCredential
    const input = document.createElement('input')
    input.id = 'otp'
    document.body.appendChild(input)

    const onCode = vi.fn()
    const dispose = observeOTP({ onCode, input: '#otp' })

    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('calls navigator.credentials.get with the WebOTP shape', async () => {
    Object.defineProperty(window, 'OTPCredential', {
      value: function OTPCredential() {},
      configurable: true,
      writable: true,
    })

    const get = vi.fn(async () => ({ code: '987654' }))
    Object.defineProperty(navigator, 'credentials', {
      value: { get },
      configurable: true,
    })

    const input = document.createElement('input')
    document.body.appendChild(input)

    const onCode = vi.fn()
    observeOTP({ onCode, input })

    // Wait a few microtasks so the credentials.get promise resolves.
    await new Promise((r) => setTimeout(r, 5))

    expect(get).toHaveBeenCalledTimes(1)
    const arg = get.mock.calls[0]![0] as {
      otp: { transport: string[] }
      signal: AbortSignal
    }
    expect(arg.otp).toEqual({ transport: ['sms'] })
    expect(arg.signal).toBeInstanceOf(AbortSignal)
    expect(onCode).toHaveBeenCalledWith('987654')
    expect(input.value).toBe('987654')
  })
})
