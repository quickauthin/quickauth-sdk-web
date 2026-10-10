#!/usr/bin/env node

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

const mapAt = code.indexOf('//# sourceMappingURL=')
const cut = mapAt === -1 ? code.length : mapAt
const patched = `${code.slice(0, cut)}\n${FLATTEN}\n${code.slice(cut)}`

writeFileSync(target, patched)
console.log('✔ dist/index.global.js global flattened to window.QuickAuth')
