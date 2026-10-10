#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

const problems = []

const bundles = ['dist/index.esm.js', 'dist/index.cjs', 'dist/index.global.js']
const files = [...bundles, 'dist/index.d.ts']

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
    if (!text.includes(`"${version}"`)) {
      problems.push(
        `${rel} does not contain the version literal "${version}" — stale build`,
      )
    }
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
