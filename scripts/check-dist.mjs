#!/usr/bin/env node
/**
 * Refuse to publish a dist/ that isn't this source tree.
 *
 * The 1.1.0 tarball on npm contains a v0.1.0 build: `npm publish` was run
 * against a stale dist/, so the package page advertised an API the shipped
 * files did not have, and every consumer of 1.1.0 got the old SDK. Nothing in
 * the pipeline noticed, because publishing does not build.
 *
 * This runs from `prepublishOnly` (after build + tests) and fails loudly if
 * the built files do not carry the current version and the current API.
 * It reads the built output only — it never trusts the build having just run.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

const problems = []

const bundles = ['dist/index.esm.js', 'dist/index.cjs', 'dist/index.global.js']
const files = [...bundles, 'dist/index.d.ts']

/** Public surface that must be present in every build from this source. */
const REQUIRED_API = [
  'resendOtp',
  'publishAutoReadCode',
  'autoSubmit',
  'setAuthEventHandler',
  'isInitialized',
  'tokenManager',
]

const contents = new Map()
for (const rel of files) {
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    problems.push(`${rel} is missing — run \`npm run build\``)
    continue
  }
  contents.set(rel, readFileSync(abs, 'utf8'))
}

for (const [rel, text] of contents) {
  const isBundle = bundles.includes(rel)

  if (isBundle) {
    // The version literal, as the minifier leaves it: `var X="1.2.0"`, which
    // both `QuickAuth.version` and the `X-QA-SDK: web/<version>` header read
    // from. A dist built at another version simply will not contain it.
    if (!text.includes(`"${version}"`)) {
      problems.push(
        `${rel} does not contain the version literal "${version}" — stale build`,
      )
    }
    // The sentinel from src/version.ts, reached only when the build-time
    // `define` did not apply. Shipping it would report a nonsense version
    // from every install in the field.
    if (text.includes('0.0.0-unbuilt')) {
      problems.push(
        `${rel} contains the 0.0.0-unbuilt sentinel — the version define did not apply`,
      )
    }
  }

  for (const symbol of REQUIRED_API) {
    if (!text.includes(symbol)) {
      problems.push(`${rel} is missing "${symbol}" — stale build`)
    }
  }
}

// The script-tag global must be flat: window.QuickAuth.init, not
// window.QuickAuth.QuickAuth.init.
const iife = contents.get('dist/index.global.js')
if (iife && !iife.includes('QuickAuth = QuickAuth.QuickAuth')) {
  problems.push(
    'dist/index.global.js is not flattened — script-tag users would need window.QuickAuth.QuickAuth',
  )
}

if (problems.length) {
  console.error(`\n✖ dist/ does not match package.json@${version}:\n`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\nRun `npm run build` and try again.\n')
  process.exit(1)
}

console.log(`✔ dist/ verified against package.json@${version}`)
