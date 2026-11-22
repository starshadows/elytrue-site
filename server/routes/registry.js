/** @param {string} path */
const exact = path => /** @type {const} */ ({ kind: 'exact', path })

/**
 * The public site is display-only. Keep only health probes in the deployed
 * Cloud Function so former account, upload, admin, and message endpoints
 * resolve to 404 at the router boundary.
 */
/** @type {readonly import('../types.js').ApiRoute[]} */
export const API_ROUTES = Object.freeze([
    { methods: ['GET'], match: exact(''), handler: 'health', auth: 'public', csrf: false },
    { methods: ['GET'], match: exact('health'), handler: 'health', auth: 'public', csrf: false },
])

/** @param {string} method @param {string} path */
export function matchApiRoute(method, path) {
    return API_ROUTES.find(route => route.methods.includes(method) && path === route.match.path)
}

/**
 * @param {readonly import('../types.js').ApiRoute[]} [routes]
 * @param {string[]} [handlerNames]
 */
export function validateApiRouteRegistry(routes = API_ROUTES, handlerNames = []) {
    const signatures = new Set()
    const handlers = new Set(handlerNames)
    for (const route of routes) {
        if (route.auth !== 'public' || route.csrf !== false) {
            throw new Error(`Display-only route has an invalid policy: ${route.handler}`)
        }
        if (!handlers.has(route.handler)) {
            throw new Error(`Missing API route handler: ${route.handler}`)
        }
        for (const method of route.methods) {
            const signature = `${method}:${route.match.path}`
            if (signatures.has(signature)) throw new Error(`Duplicate API route: ${signature}`)
            signatures.add(signature)
        }
    }
    return true
}
