declare const __QA_SDK_VERSION__: string

export const SDK_VERSION: string =
  typeof __QA_SDK_VERSION__ === 'string' ? __QA_SDK_VERSION__ : '0.0.0-unbuilt'

/** `web/<version>`, reported as `deviceInfo.sdk`. Not sent as a header: the API's CORS policy rejects custom headers like `X-QA-SDK`. */
export const SDK_TAG = `web/${SDK_VERSION}`
