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
  // The single source of the version. package.json is the only place the
  // number is written; src/version.ts reads it from here.
  define: {
    __QA_SDK_VERSION__: JSON.stringify(pkg.version),
  },
  // The IIFE global is flattened afterwards by scripts/flatten-iife.mjs — see
  // the comment there for why it is not an esbuild `footer`.
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  treeshake: true,
  target: 'es2020',
  splitting: false,
  platform: 'browser',
})
