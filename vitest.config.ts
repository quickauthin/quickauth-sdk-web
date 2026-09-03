import { defineConfig } from 'vitest/config'
import pkg from './package.json'

export default defineConfig({
  // Mirrors tsup's define so `SDK_VERSION` is the real version under test —
  // both read package.json, which is the single source of the number.
  define: {
    __QA_SDK_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
