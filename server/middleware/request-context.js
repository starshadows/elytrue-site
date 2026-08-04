import { httpError, requestOriginAllowed } from '../http.js'
import { resolveTrustedClientAddress } from '../../shared/client-identity.js'

/** @param {import('../types.js').RequestContext} context */
export function environmentFor(context) {
    return context.env || process.env
}

/**
 * @param {import('../types.js').RequestContext} context
 * @param {string} [suffix]
 * @returns {string | null}
 */
export function clientIdentity(context, suffix = '') {
    const ip = resolveTrustedClientAddress(context.request, context)
    if (!ip && !suffix) return null
    return `${ip || 'unknown'}:${suffix}`
}

/** @param {import('../types.js').RequestContext} context */
export function ensureWriteOrigin(context) {
    if (!requestOriginAllowed(context.request, environmentFor(context))) {
        const request = context.request
        const safeHost = value => {
            try {
                return new URL(value).host
            } catch {
                return ''
            }
        }
        console.warn({
            event: 'write_origin_rejected',
            method: request.method,
            requestHost: safeHost(request.url),
            originHost: safeHost(request.headers.get('origin')),
            hostHeader: request.headers.get('host') || '',
            secFetchSite: request.headers.get('sec-fetch-site') || '',
            forwardedProto: request.headers.get('x-forwarded-proto') || '',
        })
        throw httpError(403, '请求来源无效')
    }
}

