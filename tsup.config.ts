import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs', 'iife'],
  globalName: 'QuickAuth',
  outExtension: ({ format }) => {
    if (format === 'esm') return { js: '.esm.js' }
    if (format === 'cjs') return { js: '.cjs' }
    return { js: '.global.js' }
  },
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  treeshake: true,
  target: 'es2020',
  splitting: false,
  platform: 'browser',
})
