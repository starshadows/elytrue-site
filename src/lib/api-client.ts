import { beginApiRequest } from './performance'

export interface ApiEnvelope<T> {
  readonly code: number
  readonly message: string
  readonly data: T
}

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly body?: BodyInit | object
  readonly headers?: HeadersInit
  readonly signal?: AbortSignal
  readonly suppressUnauthorizedHandler?: boolean
  readonly timeoutMs?: number
  readonly updateCsrfToken?: boolean
  readonly credentials?: RequestCredentials
}

export class ApiError<T = unknown> extends Error {
  readonly status: number
  readonly code: number
  readonly data: T | null

  constructor(
    message: string,
    {
      status,
      code = status,
      data = null,
    }: { status: number; code?: number; data?: T | null },
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
  }
}

export class ApiProtocolError extends Error {
  readonly status: number
  readonly pathname: string
  readonly contentType: string

  constructor({
    status,
    pathname,
    contentType,
  }: {
    status: number
    pathname: string
    contentType: string
  }) {
    super('API 响应协议错误')
    this.name = 'ApiProtocolError'
    this.status = status
    this.pathname = pathname
    this.contentType = contentType
  }
}

export class ApiUrlError extends Error {
  readonly reason: 'origin' | 'pathname' | 'userinfo' | 'encoding'

  constructor(reason: ApiUrlError['reason']) {
    super('API 请求地址不安全')
    this.name = 'ApiUrlError'
    this.reason = reason
  }
}

export interface ApiClientHooks {
  readonly getCsrfToken?: () => string
  readonly getAuthEpoch?: () => number
  readonly setCsrfToken?: (token: string) => void
  readonly onUnauthorized?: (requestAuthEpoch: number) => void
}

export interface ApiClientOptions extends ApiClientHooks {
  readonly origin?: string
  readonly timeoutMs?: number
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'number' &&
    Number.isFinite(value.code) &&
    'message' in value &&
    typeof value.message === 'string' &&
    'data' in value
  )
}

export class ApiClient {
  readonly baseUrl: string
  readonly origin: string
  readonly timeoutMs: number
  readonly hooks: ApiClientHooks

  constructor(
    baseUrl = '/api/',
    {
      origin = globalThis.location?.origin ?? 'http://localhost',
      timeoutMs = 30_000,
      ...hooks
    }: ApiClientOptions = {},
  ) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      throw new ApiUrlError('origin')
    }
    if (!['http:', 'https:'].includes(originUrl.protocol)) {
      throw new ApiUrlError('origin')
    }
    if (originUrl.username || originUrl.password) {
      throw new ApiUrlError('userinfo')
    }
    this.origin = originUrl.origin
    this.timeoutMs = timeoutMs
    this.hooks = hooks
  }

  async request<T>(
    path: string,
    {
      method = 'GET',
      body,
      headers: suppliedHeaders,
      signal,
      suppressUnauthorizedHandler = false,
      timeoutMs = this.timeoutMs,
      updateCsrfToken = true,
      credentials = 'include',
    }: ApiRequestOptions = {},
  ): Promise<ApiEnvelope<T>> {
    const requestUrl = this.buildRequestUrl(path)
    const requestAuthEpoch = this.hooks.getAuthEpoch?.() ?? 0
    const timeoutController = new AbortController()
    const timeout = globalThis.setTimeout(
      () =>
        timeoutController.abort(
          new DOMException('Request timed out', 'TimeoutError'),
        ),
      timeoutMs,
    )
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    const headers = new Headers(suppliedHeaders)
    headers.set('Accept', 'application/json')
    headers.delete('X-CSRF-Token')

    const csrfToken = this.hooks.getCsrfToken?.()
    if (!SAFE_METHODS.has(method) && csrfToken) {
      headers.set('X-CSRF-Token', csrfToken)
    }

    let requestBody: BodyInit | undefined
    if (
      body !== undefined &&
      typeof body === 'object' &&
      !(body instanceof Blob) &&
      !(body instanceof FormData) &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body)
    ) {
      headers.set('Content-Type', 'application/json')
      requestBody = JSON.stringify(body)
    } else {
      requestBody = body as BodyInit | undefined
    }

    const measurement = beginApiRequest(
      `${requestUrl.pathname}${requestUrl.search}`,
    )
    let requestError: unknown
    try {
      const response = await fetch(requestUrl, {
        method,
        headers,
        body: SAFE_METHODS.has(method) ? undefined : requestBody,
        credentials,
        signal: combinedSignal,
      })
      measurement.response(response)
      const text = await response.text()
      let parsed: unknown = text
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          if (!response.ok) {
            throw new ApiError(response.statusText || '请求失败', {
              status: response.status,
            })
          }
        }
      }

      if (response.status === 401 && !suppressUnauthorizedHandler) {
        this.hooks.onUnauthorized?.(requestAuthEpoch)
      }
      if (!response.ok) {
        const envelope = isEnvelope(parsed) ? parsed : null
        throw new ApiError(envelope?.message || response.statusText, {
          status: response.status,
          code: envelope?.code,
          data: envelope?.data,
        })
      }
      if (!isEnvelope(parsed)) {
        throw new ApiProtocolError({
          status: response.status,
          pathname: requestUrl.pathname,
          contentType: response.headers.get('content-type') || '',
        })
      }
      const csrf =
        parsed.data &&
        typeof parsed.data === 'object' &&
        'csrfToken' in parsed.data &&
        typeof parsed.data.csrfToken === 'string'
          ? parsed.data.csrfToken
          : ''
      if (csrf && updateCsrfToken) this.hooks.setCsrfToken?.(csrf)
      return parsed as ApiEnvelope<T>
    } catch (error) {
      requestError = error
      throw error
    } finally {
      globalThis.clearTimeout(timeout)
      measurement.finish(requestError)
    }
  }

  private buildRequestUrl(path: string): URL {
    const rawPath = String(path)
    const pathOnly = rawPath.split(/[?#]/u, 1)[0] ?? ''
    if (pathOnly.includes('\\')) throw new ApiUrlError('encoding')
    if (/%(?:2e|2f|5c)/iu.test(pathOnly)) {
      throw new ApiUrlError('encoding')
    }

    let requestUrl: URL
    try {
      requestUrl = new URL(rawPath, new URL(this.baseUrl, this.origin))
    } catch {
      throw new ApiUrlError('origin')
    }
    if (requestUrl.origin !== this.origin) throw new ApiUrlError('origin')
    if (requestUrl.username || requestUrl.password) {
      throw new ApiUrlError('userinfo')
    }
    if (!requestUrl.pathname.startsWith('/api/')) {
      throw new ApiUrlError('pathname')
    }
    return requestUrl
  }
}
