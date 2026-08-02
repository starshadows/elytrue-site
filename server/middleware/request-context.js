import { httpError, requestOriginAllowed } from '../http.js'

export function environmentFor(context) {
    return context.env || process.env
}

export function clientIdentity(context, suffix = '') {
    const ip =
        context.clientIp ||
        context.request.headers.get('cf-connecting-ip') ||
        context.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown'
    return `${ip}:${suffix}`
}

export function ensureWriteOrigin(context) {
    if (!requestOriginAllowed(context.request, environmentFor(context))) {
        throw httpError(403, '请求来源无效')
    }
}

