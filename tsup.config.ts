import { defineConfig } from 'tsup'
import pkg from './package.json'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs', 'iife'],
  globalName: 'QuickAuth',
  outExtension: ({ format }) => {
    if (format === 'esm') return { js: '.esm.js' }
    if (format === 'cjs') return { js: '.cjs' }
    return { js: '.global.js' }
  },
  define: {
    __QA_SDK_VERSION__: JSON.stringify(pkg.version),
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
