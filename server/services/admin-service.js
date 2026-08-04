import { mutateUserRecord } from '../auth.js'
import { blobKeys } from '../domain/blob-keys.js'
import { httpError } from '../http.js'
import { getJSON } from '../storage.js'
import { moderateComment } from '../comments.js'
import { getUploadUsage } from './image-service.js'
import { listReports } from './report-service.js'

export async function bootstrapAdministrator(data, user, configuredSecret, suppliedSecret) {
    if (!configuredSecret || suppliedSecret !== configuredSecret) {
        throw httpError(403, '初始化凭据无效')
    }
    const marker = await getJSON(data, blobKeys.adminBootstrapClosed)
    if (marker) throw httpError(410, '管理员初始化入口已永久关闭')
    try {
        await data.setJSON(blobKeys.adminBootstrapClosed, {
            userId: user.id,
            closedAt: Date.now(),
            manual: true,
        }, { onlyIfNew: true })
    } catch (error) {
        if (
            error?.name === 'PreconditionFailedError'
            || error?.code === 'PRECONDITION_FAILED'
            || error?.statusCode === 412
        ) {
            throw httpError(410, '管理员初始化入口已永久关闭')
        }
        throw error
    }
    await mutateUserRecord(data, user, current => {
        current.role = 'admin'
    }, { claimType: 'admin-bootstrap' })
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
