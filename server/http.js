const SECURITY_HEADERS = {
    'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self'",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ].join('; '),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

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
        ...SECURITY_HEADERS,
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
            ...SECURITY_HEADERS,
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
        if (key) result[key] = decodeURIComponent(value)
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
    if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`)
    return parts.join('; ')
}

/**
 * @param {any} user
 * @param {{includePrivate?: boolean, secret?: string}} [options]
 */
export function publicUser(user, { includePrivate = false, secret } = {}) {
    const result = {
        id: user.id,
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
        const explicitlyAllowed = String(env.ALLOWED_ORIGINS || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
        if (explicitlyAllowed.includes(originUrl.origin)) return true
        return ['localhost', '127.0.0.1'].includes(originUrl.hostname)
    } catch {
        return false
    }
}
