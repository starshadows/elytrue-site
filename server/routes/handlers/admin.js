import { apiResponse, readJSON } from '../../http.js'
import { enforceRateLimit } from '../../rate-limit.js'
import { clientIdentity, environmentFor } from '../../middleware/request-context.js'
import { loadAdminService } from '../lazy-services.js'

export async function bootstrapAdmin(context, stores, path, auth) {
    await enforceRateLimit('bootstrap', clientIdentity(context, auth.user.id))
    const { bootstrapAdministrator } = await loadAdminService()
    await bootstrapAdministrator(
        stores.data,
        auth.user,
        environmentFor(context).ADMIN_BOOTSTRAP_SECRET,
        context.request.headers.get('x-admin-bootstrap-secret'),
    )
    return apiResponse(null, { message: '唯一管理员已初始化，入口已永久关闭' })
}

export async function adminReports(context, stores, path, auth) {
    await enforceRateLimit('admin', clientIdentity(context, auth.user.id))
    const { getAdminReports } = await loadAdminService()
    return apiResponse(await getAdminReports(stores.data))
}

export async function adminModerate(context, stores, path, auth) {
    await enforceRateLimit('admin', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 16 * 1024)
    const { moderateAdminComment } = await loadAdminService()
    await moderateAdminComment(stores.data, Number(body.commentId), body.action)
    return apiResponse(null, { message: '管理操作已完成' })
}

export async function adminUsage(context, stores, path, auth) {
    await enforceRateLimit('admin', clientIdentity(context, auth.user.id))
    const { getAdminUsage } = await loadAdminService()
    return apiResponse(await getAdminUsage(stores))
}
