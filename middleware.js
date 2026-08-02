const RATE_LIMIT_POLICIES = {
    '/api/user/register': ['register', 5, 60 * 60],
    '/api/user/login': ['login', 12, 15 * 60],
    '/api/user/resetpassword': ['reset', 5, 60 * 60],
    '/api/comments/post': ['comment', 10, 10 * 60],
    '/api/comments/like': ['like', 60, 10 * 60],
    '/api/comments/report': ['report', 10, 60 * 60],
    '/api/uploads/image': ['upload', 12, 10 * 60],
}

function stableHash(value) {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

function jsonResponse(status, message) {
    return new Response(JSON.stringify({ code: status, message, data: null }), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    })
}

async function enforceEdgeRateLimit(context, pathname) {
    let policy = RATE_LIMIT_POLICIES[pathname]
    if (!policy && pathname.startsWith('/api/admin/')) {
        policy = ['admin', 30, 10 * 60]
    }
    if (!policy || context.request.method === 'GET' || context.request.method === 'HEAD') {
        return null
    }

    const kv = context.env?.ELYTRUE_RATE_LIMIT_KV
    if (!kv?.get || !kv?.put) return null

    const [action, limit, windowSeconds] = policy
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
    const identity = context.clientIp || context.request.headers.get('x-forwarded-for') || 'unknown'
    const prefix = `rl_edge_${action}_${stableHash(identity)}_`
    const key = `${prefix}${bucket}`

    try {
        const count = Number(await kv.get(key, { type: 'text' }) || 0)
        if (count >= limit) return jsonResponse(429, '操作过于频繁，请稍后再试')
        await kv.put(key, String(count + 1))

        if (kv.list && kv.delete) {
            context.waitUntil?.((async () => {
                const records = await kv.list({ prefix, limit: 20 })
                await Promise.all(
                    (records?.keys || [])
                        .filter((item) => item.key !== key)
                        .map((item) => kv.delete(item.key)),
                )
            })().catch(() => {}))
        }
    } catch {
        // KV 暂时不可用时继续交给 Cloud Functions 的进程内二次限流。
    }

    return null
}

export async function middleware(context) {
    const url = new URL(context.request.url)
    if (url.hostname === 'www.elytrue.com' || url.hostname === 'blog.elytrue.com') {
        url.protocol = 'https:'
        url.hostname = 'elytrue.com'
        return context.redirect(url.toString(), 301)
    }

    const limited = await enforceEdgeRateLimit(context, url.pathname.toLowerCase())
    if (limited) return limited

    return context.next()
}

export const config = {
    matcher: '/:path*',
}
