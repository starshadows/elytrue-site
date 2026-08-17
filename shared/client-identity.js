function normalizePlatformAddress(value) {
    if (typeof value !== 'string') return null
    const address = value.trim().toLowerCase()
    if (!address || address.length > 128 || /[\s,\0]/u.test(address)) return null
    return address
}

/**
 * Resolve only addresses supplied by EdgeOne/runtime context. Proxy headers are
 * intentionally ignored because direct clients can forge them.
 */
export function resolveTrustedClientAddress(request, context = {}) {
    const edgeAddress = normalizePlatformAddress(request?.eo?.clientIp)
    if (edgeAddress) return edgeAddress
    return normalizePlatformAddress(context.clientIp)
}
