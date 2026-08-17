const enabled = Boolean(
  globalThis.performance &&
  ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ||
    globalThis.navigator?.webdriver === true),
)

interface ApiRequestMeasurement {
  response(response: Response): void
  finish(error?: unknown): void
}

const activeRequests = new Map<string, number>()
const completedRequests = new Map<string, number>()
let requestSequence = 0

export function markPerformanceEvent(
  name: string,
  detail?: Record<string, unknown>,
): void {
  if (!enabled) return
  performance.mark(name, detail ? { detail } : undefined)
}

export function beginApiRequest(url: string): ApiRequestMeasurement {
  if (!enabled) return { response() {}, finish() {} }

  const startedAt = performance.now()
  const sequence = requestSequence++
  const active = activeRequests.get(url) ?? 0
  const completed = completedRequests.get(url) ?? 0
  const detail: Record<string, unknown> = {
    url,
    firstRequest: sequence === 0,
    duplicate: active > 0 || completed > 0,
    concurrentDuplicate: active > 0,
  }
  activeRequests.set(url, active + 1)
  markPerformanceEvent('api-request-start', detail)

  let settled = false
  return {
    response(response) {
      detail.ttfb = performance.now() - startedAt
      detail.serverTiming = response.headers.get('Server-Timing') ?? ''
      detail.cacheStatus = response.headers.get('EO-Cache-Status') ?? ''
      detail.age = response.headers.get('Age') ?? ''
      detail.functionRequestId =
        response.headers.get('Functions-Request-Id') ?? ''
      detail.status = response.status
      markPerformanceEvent('api-response-headers', detail)
    },
    finish(error) {
      if (settled) return
      settled = true
      detail.total = performance.now() - startedAt
      detail.failed = Boolean(error)
      const remaining = Math.max(0, (activeRequests.get(url) ?? 1) - 1)
      if (remaining) activeRequests.set(url, remaining)
      else activeRequests.delete(url)
      completedRequests.set(url, completed + 1)
      markPerformanceEvent('api-request-complete', detail)
    },
  }
}

export function startPerformanceMark(name: string): void {
  if (!enabled) return
  performance.mark(`${name}:start`)
}

export function finishPerformanceMark(name: string): void {
  if (!enabled) return
  const start = `${name}:start`
  const end = `${name}:end`
  performance.mark(end)
  try {
    performance.measure(name, start, end)
  } catch {
    return
  } finally {
    performance.clearMarks(start)
    performance.clearMarks(end)
  }
}
