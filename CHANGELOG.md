# Changelog

All notable changes to the QuickAuth Web SDK are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.1] — 2026-10-10

First release as `@quick-auth/web-sdk` (previously `@quickauthin/web` 1.2.0).
Version 1.0.0 was never published.

### Changed (breaking)
- Package renamed to `@quick-auth/web-sdk`.
- `deviceInfo` now uses the same fields as the React Native and Flutter SDKs
  (`platform: "web"`, `osVersion`, `locale`, `timeZoneOffsetMinutes`, `appId`,
  `sdk`) plus browser details (`browserName`, `browserVersion`, `osName`,
  `mobile`, `timezone`, `userAgent`, `screen`). The exported `DeviceInfo` type
  changed shape; the old shape is now `BrowserSignals`.
- A saved consent choice wins over `init({ consent })`.
- `init()` throws when both `onTokenExpiry` and `unsafe` are passed, when
  `unsafe` is half-filled, or when `onTokenExpiry` is not a function. Error
  messages match the React Native SDK.
- `trackConversion()` sends the React Native / Flutter body
  (`event`, `value`, `currency`, `qa_clid?`, `metadata?`) and no longer rejects
  on network failure.
- `ERROR` events carry the server's message, so `message` text changed
  (e.g. `[QuickAuth] HTTP 400: phone: phone is required`).

### Added
- `publishableKey` auth mode, now the recommended way to call `init()`. The SDK
  sends the key as an `X-QuickAuth-Key` header, with no backend token endpoint
  and no session token. Matches the React Native and Flutter SDKs. It cannot be
  combined with `onTokenExpiry`, `initialToken` or `unsafe`.
- `ERROR` events and `QuickAuthError` carry `errorCode`, `status`,
  `retryAfter` and `requestId`.
- Error codes `NETWORK_ERROR`, `TIMEOUT` and `TOKEN_ERROR`.
- `requestTimeoutMs` option (default 15000).
- `debug` option: logs requests, responses, retries, token refreshes and
  events, with OTP codes and secrets masked.
- `silent` option: hides the SDK's console warnings and errors.
- `captureLaunch()` is queued until consent and sent when it is granted.
- `consent.pendingCount()` and `attribution.qaClid()`.
- `init()` and `consent.set()` return promises.
- Browser and OS versions from User-Agent Client Hints on Chromium.

### Fixed
- Browser requests no longer send the `X-QA-SDK` header: the API's CORS policy
  does not allow it, so every browser call failed the preflight with
  `NETWORK_ERROR`. The SDK version is still reported as `deviceInfo.sdk`.
- `requestTimeoutMs` now covers reading the response body: a server that sends
  headers and then stalls fails with `TIMEOUT` ("the server stopped responding
  mid-response") instead of hanging forever. A connection dropped mid-body is
  `NETWORK_ERROR` instead of an empty success. Both are retried like other
  timeouts, with the same `Idempotency-Key`.
- A 2xx the SDK cannot use — an HTML/text body (public Wi-Fi login page, wrong
  `apiBaseUrl`), an initiate without `sessionId`, a verify without `state` or
  `requestId` — is now an `ERROR` (`SERVER_ERROR`, `errorCode: 'INVALID_RESPONSE'`,
  not retried) instead of `OTP_SENT` with `sessionId: undefined` or a silent
  `OTP_FAILED`. `OTP_FAILED.message` falls back to "Incorrect code".
- WebOTP: a pending credential request is kept and shared (screen changes,
  `observeOTP` re-subscribes, `resendOtp`) instead of aborted and re-issued —
  Chrome on Android showed the consent prompt for the aborted request.
- A verify response of `{ verified: true }` without `state` counts as verified.
- `OTP_SENT.expiresIn` defaults to 300 when the server omits it.
- Surrounding whitespace in the phone number is trimmed.
- A full or blocked `localStorage` no longer throws inside SDK calls.
- A throwing `consent.onChange` listener no longer breaks `consent.set()`.
