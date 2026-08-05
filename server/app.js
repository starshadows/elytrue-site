import { errorResponse } from './http.js'
import { createStores } from './storage.js'
import { API_ROUTES, matchApiRoute, validateApiRouteRegistry } from './routes/registry.js'
import { enforceRoutePolicy } from './routes/policy.js'
import { API_ROUTE_HANDLERS } from './routes/handlers/index.js'
import { apiRoutePath } from './lib/routing.js'
import {
    attachServerTiming,
    createServerTiming,
    USER_ME_TIMING_CATEGORIES,
} from './lib/server-timing.js'

export { API_ROUTE_HANDLERS }

validateApiRouteRegistry(API_ROUTES, Object.keys(API_ROUTE_HANDLERS))

export async function handleApiRequest(context, injectedStores) {
    const stores = createStores(injectedStores)
    const request = context.request
    const method = request.method.toUpperCase()
    const path = apiRoutePath(request)

    let timing = null
    try {
        if (method === 'OPTIONS') return new Response(null, { status: 204 })
        const shouldMeasure = path === 'bootstrap'
            || path === 'user/me'
            || path === 'comments'
            || path.startsWith('comments/')
        if (shouldMeasure) {
            timing = createServerTiming(
                path === 'user/me' ? USER_ME_TIMING_CATEGORIES : undefined,
            )
            context.requestTiming = timing
            if (path !== 'user/me') context.commentTiming = timing
        }
        const route = timing
            ? await timing.measure('routing', () => Promise.resolve(matchApiRoute(method, path)))
            : matchApiRoute(method, path)
        if (!route) return errorResponse(404, '接口不存在')
        const handler = API_ROUTE_HANDLERS[route.handler]
        if (!handler) throw new Error(`API route handler is not registered: ${route.handler}`)
        const auth = timing && path !== 'user/me'
            ? await timing.measure('auth', () => enforceRoutePolicy({ context, stores, route }))
            : await enforceRoutePolicy({ context, stores, route })
        const response = await handler(context, stores, path, auth)
        return timing ? attachServerTiming(response, timing) : response
    } catch (error) {
        if (Number.isInteger(error?.status)) {
            const response = errorResponse(error.status, error.message, error.code || error.status)
            return timing ? attachServerTiming(response, timing) : response
        }
        console.error('Unhandled API error', {
            path,
            method,
            message: error?.message,
            stack: error?.stack,
        })
        const response = errorResponse(500, '服务器暂时无法处理请求')
        return timing ? attachServerTiming(response, timing) : response
    }
}
