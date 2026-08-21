/**
 * Single source of truth for the SDK version. Kept here (rather than inline at
 * each use site) because it previously drifted: the wire header advertised
 * `web/0.1.0` long after package.json had moved to 1.x. Bump this together
 * with package.json on every release.
 */
export const SDK_VERSION = '1.1.0'
