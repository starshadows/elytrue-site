import FloatMsgs from '../components/FloatMsgs'
import { ApiClient, ApiError, type ApiEnvelope } from '../lib/api-client'
import { toQueryString } from '../lib/query'
import Settings from '../settings'

interface XHRSettings {
  includeToken?: boolean
  silentStatuses?: number[]
  signal?: AbortSignal
  timeoutMs?: number
  updateCsrfToken?: boolean
}

type Payload = BodyInit | object

const XHR = {
  token: '',
  csrfToken: '',
  client: undefined as ApiClient | undefined,
  unauthorizedHandler: undefined as (() => void) | undefined,

  getClient(): ApiClient {
    this.client ??= new ApiClient('/api/', {
      getCsrfToken: () => this.csrfToken,
      setCsrfToken: (token) => {
        this.csrfToken = token
      },
      onUnauthorized: () => {
        this.token = ''
        this.csrfToken = ''
        this.unauthorizedHandler?.()
      },
    })
    return this.client
  },

  async send<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: Payload,
    settings: XHRSettings = {},
  ): Promise<T | ApiEnvelope<T>> {
    try {
      const envelope = await this.getClient().request<T>(url, {
        method,
        body: payload,
        headers: { 'Accept-Language': Settings.lang },
        signal: settings.signal,
        timeoutMs: settings.timeoutMs,
        updateCsrfToken: settings.updateCsrfToken,
      })
      if (envelope.code !== 1) {
        FloatMsgs.show({
          type: 'warn',
          msg: `${envelope.message} (${envelope.code})`,
        })
      }
      return method === 'GET' && envelope.code === 1 ? envelope.data : envelope
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      if (!settings.silentStatuses?.includes(status)) {
        const timedOut =
          error instanceof DOMException && error.name === 'TimeoutError'
        FloatMsgs.show({
          type: 'error',
          msg: timedOut
            ? '<span class="ui zh">请求超时</span><span class="ui en">Request timed out</span>'
            : error instanceof ApiError
              ? `${error.message} (${error.status})`
              : '<span class="ui zh">网络错误</span><span class="ui en">Network error</span>',
        })
      }
      throw error
    }
  },

  get<T = unknown>(
    url: string,
    payload?: object,
    settings?: XHRSettings,
  ): Promise<T> {
    return this.send<T>(
      'GET',
      url + toQueryString(payload),
      undefined,
      settings,
    ) as Promise<T>
  },

  post<T = unknown>(
    url: string,
    payload?: Payload,
    settings?: XHRSettings,
  ): Promise<ApiEnvelope<T>> {
    return this.send<T>('POST', url, payload, settings) as Promise<
      ApiEnvelope<T>
    >
  },

  put<T = unknown>(
    url: string,
    payload?: Payload,
    settings?: XHRSettings,
  ): Promise<ApiEnvelope<T>> {
    return this.send<T>('PUT', url, payload, settings) as Promise<
      ApiEnvelope<T>
    >
  },

  delete<T = unknown>(
    url: string,
    payload?: Payload,
    settings?: XHRSettings,
  ): Promise<ApiEnvelope<T>> {
    return this.send<T>('DELETE', url, payload, settings) as Promise<
      ApiEnvelope<T>
    >
  },
}

export default XHR
