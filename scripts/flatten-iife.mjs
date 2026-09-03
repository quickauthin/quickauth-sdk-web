#!/usr/bin/env node
/**
 * Flatten the script-tag global in dist/index.global.js.
 *
 * The bundler assigns the entry module's *exports object* to `globalName`,
 * and the entry exports a member called `QuickAuth` — so the global came out
 * as `window.QuickAuth.QuickAuth`, and every `<script>` user had to write
 * `QuickAuth.QuickAuth.init(...)`. That is what 1.1.0 shipped, and what
 * examples/basic.html was quietly wrong about.
 *
 * Why a post-build step and not an esbuild `footer`: tsup runs Rollup after
 * esbuild to tree-shake, and Rollup applies its own IIFE wrapper afterwards.
 * An esbuild footer therefore ends up INSIDE the closure, where `QuickAuth`
 * is the still-unassigned outer `var` — the statement throws at load and
 * takes the whole bundle with it.
 *
 * Why reassignment and not `Object.assign(QuickAuth.QuickAuth, QuickAuth)`:
 * the facade exposes `isInitialized` and `config` as getters, and copying
 * properties invokes them — `config` throws before `init()` has run, so the
 * copy would fail at load time. Reassigning keeps them live.
 *
 * The script asserts the wrapper shape it depends on, so a future bundler
 * change fails the build rather than silently shipping a broken global.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'dist/index.global.js')
const FLATTEN = 'QuickAuth = QuickAuth.QuickAuth;'

const code = readFileSync(target, 'utf8')

if (code.includes(FLATTEN)) {
  console.log('✔ dist/index.global.js global already flat')
  process.exit(0)
}

if (!/^var QuickAuth\s*=/.test(code)) {
  console.error(
    '✖ dist/index.global.js does not start with `var QuickAuth =` — the IIFE\n' +
      '  wrapper changed shape. Re-derive the flattening before shipping, or\n' +
      '  script-tag users get a broken or double-nested global.',
  )
  process.exit(1)
}

// Insert ahead of the sourcemap comment so it stays at the end of the file.
const mapAt = code.indexOf('//# sourceMappingURL=')
const cut = mapAt === -1 ? code.length : mapAt
const patched = `${code.slice(0, cut)}\n${FLATTEN}\n${code.slice(cut)}`

writeFileSync(target, patched)
console.log('✔ dist/index.global.js global flattened to window.QuickAuth')
