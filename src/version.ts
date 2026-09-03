/**
 * The one and only place the SDK version enters the source.
 *
 * `__QA_SDK_VERSION__` is substituted at build time from `package.json` —
 * see the `define` blocks in `tsup.config.ts` (bundles) and
 * `vitest.config.ts` (tests). Both read `package.json`, so package.json is
 * the single source of truth and there is no second literal to forget.
 *
 * Before this existed the version was hand-copied into three places and they
 * drifted: `QuickAuth.version` said 1.1.0 while the `X-QA-SDK` request header
 * still said `web/0.1.0`, so every dashboard chart of SDK versions in the
 * field was wrong. Add nothing here that repeats the number.
 *
 * `typeof` rather than a bare reference on purpose: if the identifier is
 * somehow not substituted (source consumed directly, an unconfigured test
 * runner), `typeof` on an undeclared name is legal JS and yields the sentinel
 * instead of a ReferenceError at import time. The sentinel is deliberately
 * NOT a plausible version — `dist` verification and the version test both
 * reject it, so a build that lost its `define` fails loudly.
 */
declare const __QA_SDK_VERSION__: string

/** Semver of this SDK build, e.g. `1.2.0`. */
export const SDK_VERSION: string =
  typeof __QA_SDK_VERSION__ === 'string' ? __QA_SDK_VERSION__ : '0.0.0-unbuilt'

/**
 * Value of the `X-QA-SDK` header sent on every request — platform + version,
 * used server-side to attribute behaviour to an SDK release.
 */
export const SDK_CLIENT_HEADER = `web/${SDK_VERSION}`
