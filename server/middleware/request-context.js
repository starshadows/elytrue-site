import { httpError, requestOriginAllowed } from '../http.js'

export function environmentFor(context) {
    return context.env || process.env
}

export function clientIdentity(context, suffix = '') {
    const ip =
        context.clientIp ||
        context.request.headers.get('cf-connecting-ip') ||
        context.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (!ip && !suffix) return null
    return `${ip || 'unknown'}:${suffix}`
}

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

