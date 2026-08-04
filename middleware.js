const RATE_LIMIT_POLICIES = {
  '/api/user/register': ['register', 20, 60 * 60],
  '/api/user/login': ['login', 12, 15 * 60],
  '/api/user/recover': ['recover', 5, 60 * 60],
  '/api/user/recovery-key': ['recovery-key', 5, 60 * 60],
  '/api/user/update': ['user-update', 30, 10 * 60],
  '/api/comments/post': ['comment', 10, 10 * 60],
  '/api/comments/like': ['like', 60, 10 * 60],
  '/api/comments/report': ['report', 10, 60 * 60],
  '/api/uploads/image': ['upload', 12, 10 * 60],
}

const TRANSPORT_SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
}

const DOCUMENT_SECURITY_HEADERS = {
  ...TRANSPORT_SECURITY_HEADERS,
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

const API_SECURITY_HEADERS = {
  ...TRANSPORT_SECURITY_HEADERS,
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers)
  const contentType = headers.get('content-type')?.toLowerCase() || ''
  const securityHeaders = contentType.includes('text/html')
    ? DOCUMENT_SECURITY_HEADERS
    : TRANSPORT_SECURITY_HEADERS
  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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
      ...API_SECURITY_HEADERS,
    },
  })
}

async function enforceEdgeRateLimit(context, pathname) {
  let policy = RATE_LIMIT_POLICIES[pathname]
  if (!policy && pathname.startsWith('/api/admin/')) {
    policy = ['admin', 30, 10 * 60]
  }
  if (
    !policy ||
    context.request.method === 'GET' ||
    context.request.method === 'HEAD'
  ) {
    return null
  }

  const kv = context.env?.ELYTRUE_RATE_LIMIT_KV
  if (!kv?.get || !kv?.put) return null

  const [action, limit, windowSeconds] = policy
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
  const identity =
    context.clientIp || context.request.headers.get('x-forwarded-for')
  // 缺少可信客户端 IP 时跳过这一层限流，避免所有访客共享全站注册桶。
  // Cloud Functions 仍会执行输入校验、唯一索引和可用身份下的二次限流。
  if (!identity) return null
  const prefix = `rl_edge_${action}_${stableHash(identity)}_`
  const key = `${prefix}${bucket}`

  try {
    const count = Number((await kv.get(key, { type: 'text' })) || 0)
    if (count >= limit) return jsonResponse(429, '操作过于频繁，请稍后再试')
    await kv.put(key, String(count + 1))

    if (kv.list && kv.delete) {
      context.waitUntil?.(
        (async () => {
          const records = await kv.list({ prefix, limit: 20 })
          await Promise.all(
            (records?.keys || [])
              .filter((item) => item.key !== key)
              .map((item) => kv.delete(item.key)),
          )
        })().catch(() => {}),
      )
    }
  } catch {
    // KV 暂时不可用时继续交给 Cloud Functions 的进程内二次限流。
  }

  return null
}

export async function middleware(context) {
  const url = new URL(context.request.url)
  if (
    url.hostname === 'www.elytrue.com' ||
    url.hostname === 'blog.elytrue.com'
  ) {
    url.protocol = 'https:'
    url.hostname = 'elytrue.com'
    return withSecurityHeaders(context.redirect(url.toString(), 301))
  }

  const limited = await enforceEdgeRateLimit(
    context,
    url.pathname.toLowerCase(),
  )
  if (limited) return limited

  return withSecurityHeaders(await context.next())
}

export const config = {
  matcher: '/:path*',
}
