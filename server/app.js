import { errorResponse } from './http.js'
import { API_ROUTES, matchApiRoute, validateApiRouteRegistry } from './routes/registry.js'
import { API_ROUTE_HANDLERS } from './routes/handlers/index.js'
import { apiRoutePath } from './lib/routing.js'

export { API_ROUTE_HANDLERS }

validateApiRouteRegistry(API_ROUTES, Object.keys(API_ROUTE_HANDLERS))

export async function handleApiRequest(context) {
    const request = context.request
    const method = request.method.toUpperCase()
    const path = apiRoutePath(request)

    try {
        if (method === 'OPTIONS') return new Response(null, { status: 204 })
        const route = matchApiRoute(method, path)
        if (!route) return errorResponse(404, '接口不存在')
        const handler = API_ROUTE_HANDLERS[route.handler]
        if (!handler) throw new Error(`API route handler is not registered: ${route.handler}`)
        return await handler(context)
    } catch (error) {
        console.error('Unhandled API error', {
            path,
            method,
            message: error?.message,
            stack: error?.stack,
        })
        return errorResponse(500, '服务器暂时无法处理请求')
    }
}
