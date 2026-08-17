export {
    API_SECURITY_HEADERS,
    BINARY_SECURITY_HEADERS,
    DOCUMENT_SECURITY_HEADERS,
} from '../shared/security-headers.js'
import {
    API_SECURITY_HEADERS,
    BINARY_SECURITY_HEADERS,
} from '../shared/security-headers.js'

/**
 * @param {unknown} [data]
 * @param {{
 *   status?: number,
 *   code?: number,
 *   message?: string,
 *   headers?: Record<string, string>,
 *   cookies?: string[],
 * }} [options]
 */
export function apiResponse(data = null, {
    status = 200,
    code = 1,
    message = 'OK',
    headers,
    cookies = [],
} = {}) {
    const responseHeaders = new Headers({
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-store',
        ...API_SECURITY_HEADERS,
        ...headers,
    })
    for (const cookie of cookies) responseHeaders.append('Set-Cookie', cookie)
    return new Response(JSON.stringify({ code, message, data }), {
        status,
        headers: responseHeaders,
    })
}

export function binaryResponse(buffer, contentType, { status = 200, cache = 'private, max-age=300' } = {}) {
    return new Response(buffer, {
        status,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': cache,
            ...BINARY_SECURITY_HEADERS,
        },
    })
}

export function errorResponse(status, message, code = status) {
    return apiResponse(null, { status, code, message })
}

export async function readJSON(request, maxBytes = 6 * 1024 * 1024) {
    const contentLength = Number(request.headers.get('content-length') || 0)
    if (contentLength > maxBytes) throw httpError(413, '请求体过大')
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw httpError(413, '请求体过大')
    if (!text) return {}
    try {
        return JSON.parse(text)
    } catch {
        throw httpError(400, '请求格式不正确')
    }
}

export function httpError(status, message, code = status) {
    return Object.assign(new Error(message), { status, code })
}

export function parseCookies(request) {
    /** @type {Record<string, string>} */
    const result = {}
    for (const item of (request.headers.get('cookie') || '').split(';')) {
        const separator = item.indexOf('=')
        if (separator < 0) continue
        const key = item.slice(0, separator).trim()
        const value = item.slice(separator + 1).trim()
        if (!key) continue
        try {
            result[key] = decodeURIComponent(value)
        } catch {
            result[key] = value
        }
    }
    return result
}

/**
 * @param {string} name
 * @param {string} value
 * @param {{maxAge?: number, httpOnly?: boolean, sameSite?: string, secure?: boolean}} [options]
 */
export function cookie(name, value, {
    maxAge,
    httpOnly = true,
    sameSite = 'Lax',
    secure = true,
} = {}) {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        `SameSite=${sameSite}`,
    ]
    if (secure) parts.push('Secure')
    if (httpOnly) parts.push('HttpOnly')
    if (typeof maxAge === 'number' && Number.isFinite(maxAge)) {
        parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`)
    }
    return parts.join('; ')
}

/**
 * EdgeOne can terminate TLS before invoking the Cloud Function, leaving an
 * internal HTTP request URL. Prefer proxy metadata, then the observable URL,
 * and finally the configured public origin. Local HTTP stays non-Secure.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} [env]
 */
export function isSecureRequest(request, env = {}) {
    const forwardedProto = request.headers
        .get('x-forwarded-proto')
        ?.split(',')[0]
        ?.trim()
        .toLowerCase()
    if (forwardedProto === 'https') return true

    try {
        if (new URL(request.url).protocol === 'https:') return true
    } catch {}

    try {
        return new URL(String(env.PUBLIC_SITE_URL || '')).protocol === 'https:'
    } catch {
        return false
    }
}

/**
 * @param {any} user
 * @param {{includePrivate?: boolean, secret?: string}} [options]
 */
export function publicUser(user, { includePrivate = false, secret } = {}) {
    const result = {
        id: user.id,
        uid: user.uid,
        name: user.name,
        avatar: user.avatarKey || '',
        create_time: Math.floor(user.createdAt / 1000),
        role: user.role === 'admin' ? 'admin' : 'user',
        hasEmail: true,
        hasPassword: true,
    }
    if (includePrivate && user.emailCipher && secret) {
        result.emailCipher = user.emailCipher
    }
    return result
}

export function requestOriginAllowed(request, env = {}) {
    const origin = request.headers.get('origin')
    if (!origin) return request.method === 'GET' || request.method === 'HEAD'
    try {
        const originUrl = new URL(origin)
        const requestUrl = new URL(request.url)
        if (originUrl.origin === requestUrl.origin) return true

        // Chromium 等现代浏览器会为同源 fetch 自动发送该 Fetch Metadata 请求头；
        // 它属于 forbidden request header，页面脚本无法自行伪造。EdgeOne 会透传
        // 客户端请求头，因此即使 Cloud Function 只看到内部 URL，也能安全识别同源写入。
        if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'same-origin') return true

        // EdgeOne 在 HTTPS 终止后可能把 Cloud Function 的 request.url 暴露为内部
        // HTTP URL，但 Host 仍是浏览器访问的公开域名。Host 由边缘平台控制，浏览器
        // 跨域脚本不能伪造，因此同 Host 可安全视为同站请求。
        const publicHosts = [
            requestUrl.host,
            request.headers.get('host'),
        ]
            .map(value => String(value || '').trim().toLowerCase())
            .filter(Boolean)
        if (publicHosts.includes(originUrl.host.toLowerCase())) return true

        const explicitlyAllowed = [
            ...String(env.ALLOWED_ORIGINS || '').split(','),
            String(env.PUBLIC_SITE_URL || ''),
        ]
            .map(value => value.trim())
            .filter(Boolean)
            .some(value => {
                try {
                    return new URL(value).origin === originUrl.origin
                } catch {
                    return false
                }
            })
        if (explicitlyAllowed) return true

        const localHosts = ['localhost', '127.0.0.1']
        return (
            localHosts.includes(originUrl.hostname) &&
            localHosts.some(host => publicHosts.some(value => value.split(':')[0] === host))
        )
    } catch {
        return false
    }
}
