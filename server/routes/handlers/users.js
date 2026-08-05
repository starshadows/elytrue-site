import {
    destroySession,
    findUserById,
    findUserByIdentifier,
    privateProfile,
    updateUser,
} from '../../auth.js'
import { apiResponse, httpError, readJSON } from '../../http.js'
import { enforceRateLimit } from '../../rate-limit.js'
import {
    clientIdentity,
    environmentFor,
} from '../../middleware/request-context.js'
import { normalizeUsername, validateUsername } from '../../../shared/validation.js'
import { loadImageService } from '../lazy-services.js'

export async function findUsers(context, stores) {
    await enforceRateLimit('userFind', clientIdentity(context))
    const url = new URL(context.request.url)
    const id = url.searchParams.get('id')
    const name = url.searchParams.get('name')
    let user = null
    if (id) {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(id)) {
            throw httpError(400, '用户 ID 格式不正确')
        }
        user = await findUserById(stores.data, id)
    } else if (name) {
        const normalizedName = normalizeUsername(name)
        if (normalizedName.includes('@')) return apiResponse([])
        const validationError = validateUsername(normalizedName)
        if (validationError) throw httpError(400, validationError)
        user = await findUserByIdentifier(
            stores.data,
            environmentFor(context),
            normalizedName,
        )
    }
    const result = user
        ? [{
            id: user.id,
            name: user.name,
            avatar: user.avatarKey || '',
            create_time: Math.floor(user.createdAt / 1000),
            // The profile action menu uses this when an administrator opens their own profile.
            role: user.role === 'admin' ? 'admin' : 'user',
        }]
        : []
    return apiResponse(result)
}

export async function updateProfile(context, stores, path, auth) {
    await enforceRateLimit('userUpdate', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 2 * 1024 * 1024)
    const updates = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.email !== undefined) updates.email = body.email
    if (body.password !== undefined) updates.password = body.password
    if (body.avatar) {
        await enforceRateLimit('upload', clientIdentity(context, auth.user.id))
        const { saveImage } = await loadImageService()
        const saved = await saveImage(stores, auth.user, body.avatar, 'avatar')
        updates.avatarKey = saved.imageId
    }
    if (Object.keys(updates).length === 0) throw httpError(400, '没有可更新的资料')
    const user = await updateUser(
        stores.data,
        stores.uploads,
        environmentFor(context),
        auth.user,
        updates,
    )
    const cookies = body.password !== undefined
        ? await destroySession(
            stores.data,
            context.request,
            auth,
            environmentFor(context),
        )
        : []
    return apiResponse(privateProfile(user, environmentFor(context)), {
        message: body.password !== undefined ? '密码已更新，请重新登录' : '资料已更新',
        cookies,
    })
}
