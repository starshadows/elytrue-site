import { getSession, verifyCsrfToken } from '../auth.js'
import { httpError } from '../http.js'
import { environmentFor, ensureWriteOrigin } from '../middleware/request-context.js'

const SAFE_METHODS = new Set(['GET', 'HEAD'])

/**
 * Resolve and enforce the declarative route policy before business code runs.
 * @param {{
 *   context: import('../types.js').RequestContext,
 *   stores: import('../types.js').Stores,
 *   route: import('../types.js').ApiRoute,
 * }} options
 * @returns {Promise<import('../types.js').AuthContext | null>}
 */
export async function enforceRoutePolicy({ context, stores, route }) {
    const request = context.request
    if (!SAFE_METHODS.has(request.method.toUpperCase())) ensureWriteOrigin(context)

    let authContext = null
    if (route.auth !== 'public') {
        authContext = await getSession(stores.data, request, {
            env: environmentFor(context),
            ...(route.handler === 'me' && context.requestTiming
                ? { timing: context.requestTiming }
                : {}),
        })
    }
    if (route.auth === 'session' && !authContext) throw httpError(401, '请先登录')
    if (route.auth === 'admin') {
        if (!authContext) throw httpError(401, '请先登录')
        if (authContext.user.role !== 'admin') throw httpError(403, '无管理权限')
    }
    if (route.csrf) {
        if (!authContext) throw httpError(401, '请先登录')
        verifyCsrfToken(authContext, request)
    }
    return authContext
}
