import { beforeEach, describe, expect, it, vi } from 'vitest'
import pkg from '../package.json'
import { QuickAuth } from '../src/index'
import type { AuthEvent } from '../src/types'
import { SDK_CLIENT_HEADER, SDK_VERSION } from '../src/version'
import { fakeJwt, flush, initSdk, makeMockFetch, resetSdk } from './_helpers'

describe('facade surface', () => {
  beforeEach(resetSdk)

  it('exposes the documented members', () => {
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch })

    expect(typeof QuickAuth.init).toBe('function')
    expect(typeof QuickAuth.isInitialized).toBe('boolean')
    expect(typeof QuickAuth.config).toBe('object')
    expect(typeof QuickAuth.tokenManager.getToken).toBe('function')
    expect(typeof QuickAuth.tokenManager.invalidate).toBe('function')
    expect(typeof QuickAuth.setAuthEventHandler).toBe('function')
    expect(typeof QuickAuth.consent.set).toBe('function')
    expect(typeof QuickAuth.attribution.captureLaunch).toBe('function')
    expect(typeof QuickAuth.whatsapp.open).toBe('function')
    expect(typeof QuickAuth.reset).toBe('function')

    for (const method of [
      'initiate',
      'submitOtp',
      'resendOtp',
      'publishAutoReadCode',
      'reset',
      'observeOTP',
      'startWhatsAppLogin',
    ]) {
      expect(typeof (QuickAuth.auth as Record<string, unknown>)[method]).toBe(
        'function',
      )
    }
  })

  it('reports isInitialized around init() and reset()', () => {
    expect(QuickAuth.isInitialized).toBe(false)
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch })
    expect(QuickAuth.isInitialized).toBe(true)
    QuickAuth.reset()
    expect(QuickAuth.isInitialized).toBe(false)
  })

  it('config throws before init rather than handing back a half-built object', () => {
    expect(() => QuickAuth.config).toThrow(/not initialised/i)
  })

  it('config reflects what was passed to init', () => {
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch })
    expect(QuickAuth.config.apiBaseUrl).toBe('https://api.test.local')
    expect(QuickAuth.config.maxRetries).toBe(0)
  })

  it('setAuthEventHandler attaches a handler after init', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    const events: AuthEvent[] = []
    QuickAuth.setAuthEventHandler((e) => events.push(e))

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await flush()

    expect(events.map((e) => e.type)).toEqual(['OTP_SENT'])
  })

  it('setAuthEventHandler(null) detaches', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    const events: AuthEvent[] = []
    initSdk({
      fetch: mock.fn as unknown as typeof fetch,
      consent: false,
      onAuthEvent: (e) => events.push(e as AuthEvent),
    })
    QuickAuth.setAuthEventHandler(null)

    await QuickAuth.auth.initiate({ phone: '+919876543210' })
    await flush()

    expect(events).toEqual([])
  })

  it('tokenManager is the live cache, not a copy of it', async () => {
    const seeded = fakeJwt(600)
    const minted = fakeJwt(900)
    const provider = vi.fn(async () => minted)
    initSdk({
      fetch: makeMockFetch().fn as unknown as typeof fetch,
      initialToken: seeded,
      onTokenExpiry: provider,
    })

    // Same object the SDK itself uses — not a snapshot taken at init.
    expect(QuickAuth.tokenManager).toBe(QuickAuth._internal.tokenManager)
    await expect(QuickAuth.tokenManager.getToken()).resolves.toBe(seeded)
    expect(provider).not.toHaveBeenCalled() // served from initialToken
  })

  it('tokenManager.getToken drives the configured provider', async () => {
    const minted = fakeJwt(900)
    const provider = vi.fn(async () => minted)
    QuickAuth.init({
      apiBaseUrl: 'https://api.test.local',
      fetch: makeMockFetch().fn as unknown as typeof fetch,
      onTokenExpiry: provider,
    })

    await expect(QuickAuth.tokenManager.getToken()).resolves.toBe(minted)
    expect(provider).toHaveBeenCalledTimes(1)

    // Cached — a second read must not re-mint.
    await QuickAuth.tokenManager.getToken()
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('reset() returns the SDK to its pre-init state', async () => {
    initSdk({ fetch: makeMockFetch().fn as unknown as typeof fetch })
    QuickAuth.reset()

    await expect(
      QuickAuth.auth.initiate({ phone: '+919876543210' }),
    ).rejects.toThrow(/not initialised/i)
  })
})

describe('version is single-sourced', () => {
  beforeEach(resetSdk)

  it('QuickAuth.version comes from package.json', () => {
    expect(SDK_VERSION).toBe(pkg.version)
    expect(QuickAuth.version).toBe(pkg.version)
    // The sentinel means the build-time define did not apply.
    expect(QuickAuth.version).not.toContain('unbuilt')
  })

  it('sends the same version in the X-QA-SDK header', async () => {
    const mock = makeMockFetch()
    mock.reply({ state: 'OTP_SENT', sessionId: 'sess_1', expiresIn: 300 })
    initSdk({ fetch: mock.fn as unknown as typeof fetch, consent: false })

    await QuickAuth.auth.initiate({ phone: '+919876543210' })

    const [, init] = mock.fn.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(SDK_CLIENT_HEADER).toBe(`web/${pkg.version}`)
    expect(headers['X-QA-SDK']).toBe(`web/${pkg.version}`)
  })
})
