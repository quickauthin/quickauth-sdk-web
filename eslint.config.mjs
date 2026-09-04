// Flat config (ESLint 9). Deliberately narrow: this is a dependency-free
// browser SDK, so the rules that matter are the ones that catch a real defect
// shipping to somebody else's site — not stylistic preference, which the
// formatter and review already cover.
//
// Type-aware linting is intentionally NOT enabled. `npm run typecheck` already
// runs the full compiler over the same files, so turning it on here would
// double the work and the runtime for no extra signal.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Build output and dependencies are never linted.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'examples/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser surface the SDK actually touches.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        queueMicrotask: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      // An unused variable is usually a half-finished edit. Underscore-prefixed
      // names are the documented escape hatch for deliberately-ignored args.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` is allowed but flagged — this SDK decodes untrusted JSON from the
      // network, where a narrow `unknown` is right but `any` is sometimes the
      // pragmatic answer at a boundary.
      '@typescript-eslint/no-explicit-any': 'warn',
      // The one that actually bites in an SDK: a promise nobody awaited means a
      // rejection nobody handles, surfacing as an unhandled rejection in the
      // host page rather than an error the caller can catch.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Tests reach for globals and loose typing that production code should not.
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly', it: 'readonly', expect: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', vi: 'readonly',
        global: 'readonly', globalThis: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
)
