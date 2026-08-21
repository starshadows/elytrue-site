export const TRANSPORT_SECURITY_HEADERS = Object.freeze({
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
})

export const CRITICAL_STARTUP_SCRIPT_HASH =
    'sha256-98wEKMYbrArsobYVYW2aI4tgCAHNBn/bIONvxKDgJDc='

export const DOCUMENT_SECURITY_HEADERS = Object.freeze({
    ...TRANSPORT_SECURITY_HEADERS,
    'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        `script-src 'self' '${CRITICAL_STARTUP_SCRIPT_HASH}'`,
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ].join('; '),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
})

export const API_SECURITY_HEADERS = Object.freeze({
    ...TRANSPORT_SECURITY_HEADERS,
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
})

// Binary resources intentionally omit document-only CSP, framing, and feature policy.
export const BINARY_SECURITY_HEADERS = Object.freeze({
    ...TRANSPORT_SECURITY_HEADERS,
    'Referrer-Policy': 'no-referrer',
})
