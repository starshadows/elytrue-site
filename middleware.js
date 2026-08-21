import {
  DOCUMENT_SECURITY_HEADERS,
  TRANSPORT_SECURITY_HEADERS,
} from './shared/security-headers.js'

export const RATE_LIMIT_POLICIES = Object.freeze({})

const STATIC_PATHS = new Set(['/index.manifest.json', '/social-share.jpg'])

export function isStaticAssetRequest(request, pathname) {
  const method = request.method.toUpperCase()
  return (
    (method === 'GET' || method === 'HEAD') &&
    (pathname.startsWith('/assets/') ||
      pathname.startsWith('/res/') ||
      STATIC_PATHS.has(pathname))
  )
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

  if (isStaticAssetRequest(context.request, url.pathname)) {
    return context.next()
  }

  return withSecurityHeaders(await context.next())
}

export const config = {
  matcher: '/:path*',
}
