/** @param {string} path */
const exact = path => /** @type {const} */ ({ kind: 'exact', path })
/** @param {string} path */
const prefix = path => /** @type {const} */ ({ kind: 'prefix', path })

/**
 * Public API contract. Authentication, CSRF, and admin metadata describe the
 * requirements enforced by each handler and are also consumed by contract
 * tests and architecture documentation.
 */
/** @type {readonly import('../types.js').ApiRoute[]} */
export const API_ROUTES = Object.freeze([
    { methods: ['GET'], match: exact(''), handler: 'health', auth: 'public', csrf: false },
    { methods: ['GET'], match: exact('health'), handler: 'health', auth: 'public', csrf: false },
    { methods: ['GET'], match: exact('bootstrap'), handler: 'bootstrap', auth: 'optional', csrf: false },
    { methods: ['POST'], match: exact('user/register'), handler: 'register', auth: 'public', csrf: false },
    { methods: ['POST'], match: exact('user/login'), handler: 'login', auth: 'public', csrf: false },
    { methods: ['POST'], match: exact('user/logout'), handler: 'logout', auth: 'session', csrf: true },
    {
        methods: ['POST'],
        match: exact('user/resettoken'),
        handler: 'logoutAll',
        auth: 'session',
        csrf: true,
    },
    { methods: ['GET'], match: exact('user/me'), handler: 'me', auth: 'optional', csrf: false },
    { methods: ['GET'], match: exact('user/find'), handler: 'findUsers', auth: 'public', csrf: false },
    { methods: ['PUT'], match: exact('user/update'), handler: 'updateProfile', auth: 'session', csrf: true },
    {
        methods: ['POST'],
        match: exact('user/recover'),
        handler: 'recoverUser',
        auth: 'public',
        csrf: false,
    },
    {
        methods: ['POST'],
        match: exact('user/recovery-key'),
        handler: 'updateRecoveryKey',
        auth: 'session',
        csrf: true,
    },
    { methods: ['POST'], match: exact('uploads/image'), handler: 'uploadImage', auth: 'session', csrf: true },
    { methods: ['DELETE'], match: exact('uploads/image'), handler: 'deleteImage', auth: 'session', csrf: true },
    {
        methods: ['GET'],
        match: exact('data/images/defaultAvatar.png'),
        handler: 'defaultAvatar',
        auth: 'public',
        csrf: false,
    },
    {
        methods: ['GET'],
        match: prefix('data/images/avatars/'),
        handler: 'avatarImage',
        auth: 'public',
        csrf: false,
    },
    {
        methods: ['GET'],
        match: prefix('data/images/posts/'),
        handler: 'commentImage',
        auth: 'public',
        csrf: false,
    },
    { methods: ['GET'], match: exact('comments'), handler: 'comments', auth: 'optional', csrf: false },
    { methods: ['GET'], match: exact('comments/count'), handler: 'commentCount', auth: 'public', csrf: false },
    { methods: ['POST'], match: exact('comments/post'), handler: 'postComment', auth: 'session', csrf: true },
    { methods: ['POST'], match: exact('comments/like'), handler: 'likeComment', auth: 'session', csrf: true },
    {
        methods: ['DELETE'],
        match: exact('comments/like'),
        handler: 'unlikeComment',
        auth: 'session',
        csrf: true,
    },
    {
        methods: ['POST'],
        match: exact('comments/report'),
        handler: 'reportComment',
        auth: 'session',
        csrf: true,
    },
    { methods: ['POST'], match: exact('admin/bootstrap'), handler: 'bootstrapAdmin', auth: 'session', csrf: true },
    { methods: ['GET'], match: exact('admin/reports'), handler: 'adminReports', auth: 'admin', csrf: false },
    {
        methods: ['POST'],
        match: exact('admin/comments/moderate'),
        handler: 'adminModerate',
        auth: 'admin',
        csrf: true,
    },
    { methods: ['GET'], match: exact('admin/usage'), handler: 'adminUsage', auth: 'admin', csrf: false },
])

/** @param {string} method @param {string} path */
export function matchApiRoute(method, path) {
    return API_ROUTES.find(route => {
        if (!route.methods.includes(method)) return false
        return route.match.kind === 'exact' ? path === route.match.path : path.startsWith(route.match.path)
    })
}

/**
 * @param {readonly import('../types.js').ApiRoute[]} [routes]
 * @param {string[]} [handlerNames]
 */
export function validateApiRouteRegistry(routes = API_ROUTES, handlerNames = []) {
    const signatures = new Set()
    const handlers = new Set(handlerNames)
    for (const route of routes) {
        if (!['public', 'optional', 'session', 'admin'].includes(route.auth)) {
            throw new Error(`Invalid API route auth policy: ${route.handler}`)
        }
        if (typeof route.csrf !== 'boolean') {
            throw new Error(`Missing API route CSRF policy: ${route.handler}`)
        }
        if (!handlers.has(route.handler)) {
            throw new Error(`Missing API route handler: ${route.handler}`)
        }
        for (const method of route.methods) {
            const signature = `${method} ${route.match.kind}:${route.match.path}`
            if (signatures.has(signature)) throw new Error(`Duplicate API route: ${signature}`)
            signatures.add(signature)
        }
    }
    return true
}

