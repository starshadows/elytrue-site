import { requireSession } from '../auth.js'
import { blobKeys } from '../domain/blob-keys.js'
import { httpError } from '../http.js'
import { getJSON } from '../storage.js'
import { moderateComment } from '../comments.js'
import { getUploadUsage } from './image-service.js'
import { listReports } from './report-service.js'

export async function authorizeAdmin(data, request, env, enforceLimit) {
    const auth = await requireSession(data, request, {
        csrf: !['GET', 'HEAD'].includes(request.method.toUpperCase()),
        env,
    })
    if (auth.user.role !== 'admin') throw httpError(403, '无管理权限')
    await enforceLimit(auth.user)
    return auth
}

export async function bootstrapAdministrator(data, user, configuredSecret, suppliedSecret) {
    if (!configuredSecret || suppliedSecret !== configuredSecret) {
        throw httpError(403, '初始化凭据无效')
    }
    const marker = await getJSON(data, blobKeys.adminBootstrapClosed)
    if (marker) throw httpError(410, '管理员初始化入口已永久关闭')
    user.role = 'admin'
    user.updatedAt = Date.now()
    await data.setJSON(blobKeys.user(user.id), user)
    await data.setJSON(blobKeys.adminBootstrapClosed, {
        userId: user.id,
        closedAt: Date.now(),
    }, { onlyIfNew: true })
}

export async function getAdminReports(data) {
    return listReports(data)
}

export async function moderateAdminComment(data, commentId, action) {
    return moderateComment(data, commentId, action)
}

export async function getAdminUsage(stores) {
    return getUploadUsage(stores)
}
