import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import pkg from '../package.json'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'dist/index.global.js')
const built = existsSync(bundlePath)

if (!built) {
  console.warn(
    `[iife.test] skipped — ${bundlePath} not found. Run \`npm run build\` first.`,
  )
}

describe.skipIf(!built)('dist/index.global.js (script-tag build)', () => {
  const globalScope = globalThis as unknown as Record<string, unknown>

  function loadBundle(): Record<string, unknown> {
    delete globalScope.QuickAuth
    const code = readFileSync(bundlePath, 'utf8')
    ;(0, eval)(code)
    return globalScope.QuickAuth as Record<string, unknown>
  }

  it('exposes a flat window.QuickAuth', () => {
    const QuickAuth = loadBundle()

    expect(typeof QuickAuth).toBe('object')
    expect(typeof (window as unknown as Record<string, unknown>).QuickAuth).toBe(
      'object',
    )
    expect(typeof QuickAuth.init).toBe('function')
    expect(QuickAuth.QuickAuth).toBeUndefined()
  })

  it('carries the full public API onto the global', () => {
    const QuickAuth = loadBundle()
    const auth = QuickAuth.auth as Record<string, unknown>

    expect(QuickAuth.version).toBe(pkg.version)
    expect(typeof QuickAuth.isInitialized).toBe('boolean')
    expect(typeof QuickAuth.setAuthEventHandler).toBe('function')
    expect(typeof QuickAuth.tokenManager).toBe('object')
    expect(typeof QuickAuth.reset).toBe('function')
    expect(typeof QuickAuth.QuickAuthError).toBe('function')
    expect(typeof auth.initiate).toBe('function')
    expect(typeof auth.submitOtp).toBe('function')
    expect(typeof auth.resendOtp).toBe('function')
    expect(typeof auth.publishAutoReadCode).toBe('function')
    expect(typeof auth.observeOTP).toBe('function')
  })

  it('backs every QuickAuth.* path used by examples/basic.html', () => {
    const QuickAuth = loadBundle()
    const html = readFileSync(join(root, 'examples/basic.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    const paths = new Set(
      Array.from(
        html.matchAll(/\bQuickAuth((?:\.[A-Za-z_$][\w$]*)+)/g),
        (m) => m[1]!,
      ),
    )
    expect(paths.size).toBeGreaterThan(4)

    for (const path of paths) {
      const resolved = path
        .slice(1)
        .split('.')
        .reduce<unknown>(
          (obj, key) =>
            obj == null ? undefined : (obj as Record<string, unknown>)[key],
          QuickAuth,
        )
      expect(resolved, `examples/basic.html uses QuickAuth${path}`).toBeDefined()
    }
  })

  it('does not throw while evaluating the getters it exposes', () => {
    const QuickAuth = loadBundle()
    expect(QuickAuth.isInitialized).toBe(false)
    expect(() => QuickAuth.config).toThrow(/QuickAuth/)
  })
})
