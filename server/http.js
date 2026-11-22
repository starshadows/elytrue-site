export {
  API_SECURITY_HEADERS,
  DOCUMENT_SECURITY_HEADERS,
} from '../shared/security-headers.js'
import { API_SECURITY_HEADERS } from '../shared/security-headers.js'

/**
 * @param {unknown} [data]
 * @param {{
 *   status?: number,
 *   code?: number,
 *   message?: string,
 *   headers?: Record<string, string>,
 * }} [options]
 */
export function apiResponse(
  data = null,
  { status = 200, code = 1, message = 'OK', headers } = {},
) {
  const responseHeaders = new Headers({
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store',
    ...API_SECURITY_HEADERS,
    ...headers,
  })
  return new Response(JSON.stringify({ code, message, data }), {
    status,
    headers: responseHeaders,
  })
}

/**
 * @param {number} status
 * @param {string} message
 * @param {number} [code]
 */
export function errorResponse(status, message, code = status) {
  return apiResponse(null, { status, code, message })
}
