import { randomUUID } from 'node:crypto'
import {
    authenticateUser,
    createSession,
    destroySession,
    findUserById,
    findUserByIdentifier,
    getAppSecret,
    getSession,
    privateProfile,
    registerUser,
    requireSession,
    revokeAllSessions,
    updateUser,
} from './auth.js'
import {
    createComment,
    createReport,
    listComments,
    listReports,
    moderateComment,
    setLike,
} from './comments.js'
import { sha256, randomToken, hashPassword, decryptEmail } from './crypto.js'
import { sendPasswordResetEmail } from './email.js'
import {
    apiResponse,
    binaryResponse,
    errorResponse,
    httpError,
    readJSON,
    requestOriginAllowed,
} from './http.js'
import { contentTypeForKey, decodeBase64Image, validateImage } from './images.js'
import { enforceRateLimit } from './rate-limit.js'
import { createStores, getJSON, listAll } from './storage.js'
import { validatePassword } from '../shared/validation.js'

const MAX_AVATAR_BYTES = 1024 * 1024
const MAX_COMMENT_IMAGE_BYTES = 2 * 1024 * 1024
const BLOB_FREE_BYTES = 1024 * 1024 * 1024
const UPLOAD_STOP_BYTES = Math.floor(BLOB_FREE_BYTES * 0.9)
const UPLOAD_WARNING_BYTES = Math.floor(BLOB_FREE_BYTES * 0.8)

function routePath(request) {
    const path = new URL(request.url).pathname
    return decodeURIComponent(path.replace(/^\/api\/?/u, '').replace(/\/+$/u, ''))
}

function envFor(context) {
    return context.env || process.env
}

function authenticatedProfile(user, env, session) {
    return {
        ...privateProfile(user, env),
        csrfToken: session.csrfToken,
    }
}

function clientIdentity(context, suffix = '') {
    const ip = context.clientIp
        || context.request.headers.get('cf-connecting-ip')
        || context.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || 'unknown'
    return `${ip}:${suffix}`
}

async function ensureWriteOrigin(context) {
    if (!requestOriginAllowed(context.request, envFor(context))) {
        throw httpError(403, '请求来源无效')
    }
}

async function saveImage({ data, uploads }, user, base64, kind) {
    const maxBytes = kind === 'avatar' ? MAX_AVATAR_BYTES : MAX_COMMENT_IMAGE_BYTES
    const buffer = decodeBase64Image(base64, maxBytes)
    const image = validateImage(buffer, maxBytes)
    const usage = await getJSON(data, 'usage/uploads.json') || { uploadedBytes: 0, updatedAt: 0 }
    if (Number(usage.uploadedBytes || 0) + buffer.length >= UPLOAD_STOP_BYTES) {
        throw httpError(507, '图片存储空间接近免费额度上限，已暂停新图片上传')
    }

    const imageId = randomUUID()
    const blobKey = `${kind === 'avatar' ? 'avatars' : 'comments'}/${user.id}/${imageId}.${image.ext}`
    await uploads.set(blobKey, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    const aliasKey = `uploads/aliases/${kind === 'avatar' ? 'avatars' : 'comments'}/${imageId}.json`
    await data.setJSON(aliasKey, {
        imageId,
        userId: user.id,
        blobKey,
        contentType: image.type,
        width: image.width,
        height: image.height,
        size: buffer.length,
        createdAt: Date.now(),
    }, { onlyIfNew: true })

    usage.uploadedBytes = Number(usage.uploadedBytes || 0) + buffer.length
    usage.updatedAt = Date.now()
    usage.warning = usage.uploadedBytes >= UPLOAD_WARNING_BYTES
    await data.setJSON('usage/uploads.json', usage)
    if (usage.warning) console.warn('Elytrue Blob usage has reached the 80% warning threshold.')
    return { imageId, blobKey, size: buffer.length }
}

async function serveImage(stores, kind, imageId) {
    const alias = await getJSON(
        stores.data,
        `uploads/aliases/${kind === 'avatars' ? 'avatars' : 'comments'}/${imageId}.json`,
    )
    if (!alias?.blobKey) return errorResponse(404, '图片不存在')
    const buffer = await stores.uploads.get(alias.blobKey, {
        type: 'arrayBuffer',
        consistency: 'strong',
    })
    if (!buffer) return errorResponse(404, '图片不存在')
    return binaryResponse(buffer, alias.contentType || contentTypeForKey(alias.blobKey), {
        cache: 'public, max-age=31536000, immutable',
    })
}

async function register(context, stores) {
    await ensureWriteOrigin(context)
    await enforceRateLimit('register', clientIdentity(context))
    const body = await readJSON(context.request, 32 * 1024)
    const user = await registerUser(stores.data, envFor(context), {
        name: body.name,
        email: body.email,
        password: body.password,
    })
    const { session, cookies } = await createSession(stores.data, user, context.request)
    return apiResponse(authenticatedProfile(user, envFor(context), session), {
        status: 201,
        message: '注册成功',
        cookies,
    })
}

async function login(context, stores) {
    await ensureWriteOrigin(context)
    const body = await readJSON(context.request, 32 * 1024)
    const identifier = body.identifier || body.email || body.name || ''
    await enforceRateLimit('login', clientIdentity(context, String(identifier).toLowerCase()))
    const user = await authenticateUser(stores.data, envFor(context), identifier, body.password || '')
    const { session, cookies } = await createSession(stores.data, user, context.request)
    return apiResponse(authenticatedProfile(user, envFor(context), session), {
        message: '登录成功',
        cookies,
    })
}

async function logout(context, stores, allDevices = false) {
    await ensureWriteOrigin(context)
    const auth = await requireSession(stores.data, context.request)
    if (allDevices) await revokeAllSessions(stores.data, auth.user)
    const cookies = await destroySession(stores.data, context.request, auth)
    return apiResponse(null, { message: '已退出登录', cookies })
}

async function getMe(context, stores) {
    const auth = await requireSession(stores.data, context.request, { csrf: false })
    return apiResponse(authenticatedProfile(auth.user, envFor(context), auth.session), {
        cookies: auth.refreshCookies,
    })
}

async function findUsers(context, stores) {
    const url = new URL(context.request.url)
    const id = url.searchParams.get('id')
    const name = url.searchParams.get('name')
    let user = null
    if (id) user = await findUserById(stores.data, id)
    else if (name && !name.includes('@')) user = await findUserByIdentifier(stores.data, envFor(context), name)
    const result = user
        ? [{
            id: user.id,
            name: user.name,
            avatar: user.avatarKey || '',
            create_time: Math.floor(user.createdAt / 1000),
            role: user.role === 'admin' ? 'admin' : 'user',
            hasEmail: true,
            hasPassword: true,
        }]
        : []
    return apiResponse(result)
}

async function updateProfile(context, stores) {
    await ensureWriteOrigin(context)
    const auth = await requireSession(stores.data, context.request)
    const body = await readJSON(context.request, 2 * 1024 * 1024)
    const updates = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.email !== undefined) updates.email = body.email
    if (body.password !== undefined) updates.password = body.password
    if (body.avatar) {
        await enforceRateLimit('upload', clientIdentity(context, auth.user.id))
        const saved = await saveImage(stores, auth.user, body.avatar, 'avatar')
        updates.avatarKey = saved.imageId
    }
    const user = await updateUser(stores.data, stores.uploads, envFor(context), auth.user, updates)
    const cookies = body.password !== undefined
        ? await destroySession(stores.data, context.request, auth)
        : []
    return apiResponse(privateProfile(user, envFor(context)), {
        message: body.password !== undefined ? '密码已更新，请重新登录' : '资料已更新',
        cookies,
    })
}

async function requestPasswordReset(context, stores) {
    await ensureWriteOrigin(context)
    const url = new URL(context.request.url)
    const body = context.request.headers.get('content-type')?.includes('application/json')
        ? await readJSON(context.request, 32 * 1024)
        : {}
    const identifier = body.identifier || body.email || url.searchParams.get('email') || ''
    await enforceRateLimit('reset', clientIdentity(context, String(identifier).toLowerCase()))
    const user = await findUserByIdentifier(stores.data, envFor(context), identifier)
    if (user) {
        const token = randomToken(32)
        await stores.data.setJSON(`password-resets/${sha256(token)}.json`, {
            userId: user.id,
            expiresAt: Date.now() + 30 * 60 * 1000,
            createdAt: Date.now(),
        }, { onlyIfNew: true })
        try {
            await sendPasswordResetEmail(envFor(context), {
                email: decryptEmail(getAppSecret(envFor(context)), user.emailCipher),
                username: user.name,
                token,
            })
        } catch (error) {
            console.error('Password reset email unavailable', error?.message)
        }
    }
    return apiResponse(null, {
        message: '如果账号存在，重置邮件会发送到注册邮箱',
    })
}

async function completePasswordReset(context, stores) {
    await ensureWriteOrigin(context)
    const body = await readJSON(context.request, 32 * 1024)
    const token = String(body.id || body.token || '')
    const password = body.data ?? body.password
    const passwordError = validatePassword(password)
    if (!token || passwordError) throw httpError(400, passwordError || '重置链接无效')
    const key = `password-resets/${sha256(token)}.json`
    const reset = await getJSON(stores.data, key)
    if (!reset || reset.expiresAt <= Date.now()) throw httpError(400, '重置链接无效或已过期')
    const user = await findUserById(stores.data, reset.userId)
    if (!user) throw httpError(400, '重置链接无效或已过期')
    user.passwordHash = await hashPassword(password)
    user.sessionVersion = Number(user.sessionVersion || 0) + 1
    user.updatedAt = Date.now()
    await stores.data.setJSON(`users/${user.id}.json`, user)
    await stores.data.delete(key)
    return apiResponse(null, { message: '密码已重置，请重新登录' })
}

async function uploadCommentImage(context, stores) {
    await ensureWriteOrigin(context)
    const auth = await requireSession(stores.data, context.request)
    await enforceRateLimit('upload', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 3 * 1024 * 1024)
    const saved = await saveImage(stores, auth.user, body.image, 'comment')
    return apiResponse({ imageId: saved.imageId }, { status: 201, message: '图片已上传' })
}

async function postComment(context, stores) {
    await ensureWriteOrigin(context)
    const auth = await requireSession(stores.data, context.request)
    await enforceRateLimit('comment', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 64 * 1024)
    const comment = await createComment(stores.data, auth.user, body)
    return apiResponse(comment, { status: 201, message: '留言已发布' })
}

async function getComments(context, stores) {
    const auth = await getSession(stores.data, context.request)
    const url = new URL(context.request.url)
    const comments = await listComments(stores.data, url.searchParams, auth?.user)
    return apiResponse(comments, { cookies: auth?.refreshCookies || [] })
}

async function commentsCount(context, stores) {
    const auth = await getSession(stores.data, context.request)
    const url = new URL(context.request.url)
    const query = new URLSearchParams(url.searchParams)
    query.set('count', '100')
    const comments = await listComments(stores.data, query, auth?.user)
    return apiResponse(comments.length)
}

async function likeComment(context, stores, liked) {
    await ensureWriteOrigin(context)
    const auth = await requireSession(stores.data, context.request)
    await enforceRateLimit('like', clientIdentity(context, auth.user.id))
    const commentId = Number(new URL(context.request.url).searchParams.get('commentId'))
    if (!Number.isSafeInteger(commentId)) throw httpError(400, '留言编号无效')
    await setLike(stores.data, commentId, auth.user, liked)
    return apiResponse(null, { message: liked ? '已点赞' : '已取消点赞' })
}

async function reportComment(context, stores) {
    await ensureWriteOrigin(context)
    const auth = await requireSession(stores.data, context.request)
    await enforceRateLimit('report', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 16 * 1024)
    const commentId = Number(body.commentId || new URL(context.request.url).searchParams.get('commentId'))
    await createReport(stores.data, commentId, auth.user, body.reason)
    return apiResponse(null, { message: '举报已提交' })
}

async function requireAdmin(context, stores) {
    const auth = await requireSession(stores.data, context.request, {
        csrf: !['GET', 'HEAD'].includes(context.request.method.toUpperCase()),
    })
    if (auth.user.role !== 'admin') throw httpError(403, '无管理权限')
    await enforceRateLimit('admin', clientIdentity(context, auth.user.id))
    return auth
}

async function bootstrapAdmin(context, stores) {
    await ensureWriteOrigin(context)
    const auth = await requireSession(stores.data, context.request)
    const configured = envFor(context).ADMIN_BOOTSTRAP_SECRET
    const supplied = context.request.headers.get('x-admin-bootstrap-secret')
    if (!configured || supplied !== configured) throw httpError(403, '初始化凭据无效')
    const markerKey = 'system/admin-bootstrap-closed.json'
    const marker = await getJSON(stores.data, markerKey)
    if (marker) throw httpError(410, '管理员初始化入口已永久关闭')
    auth.user.role = 'admin'
    auth.user.updatedAt = Date.now()
    await stores.data.setJSON(`users/${auth.user.id}.json`, auth.user)
    await stores.data.setJSON(markerKey, {
        userId: auth.user.id,
        closedAt: Date.now(),
    }, { onlyIfNew: true })
    return apiResponse(null, { message: '唯一管理员已初始化，入口已永久关闭' })
}

async function adminReports(context, stores) {
    await requireAdmin(context, stores)
    return apiResponse(await listReports(stores.data))
}

async function adminModerate(context, stores) {
    await ensureWriteOrigin(context)
    await requireAdmin(context, stores)
    const body = await readJSON(context.request, 16 * 1024)
    await moderateComment(stores.data, Number(body.commentId), body.action)
    return apiResponse(null, { message: '管理操作已完成' })
}

async function adminUsage(context, stores) {
    await requireAdmin(context, stores)
    const usage = await getJSON(stores.data, 'usage/uploads.json') || { uploadedBytes: 0 }
    return apiResponse({
        ...usage,
        warningAt: UPLOAD_WARNING_BYTES,
        uploadsStopAt: UPLOAD_STOP_BYTES,
        freeQuotaReference: BLOB_FREE_BYTES,
    })
}

export async function handleApiRequest(context, injectedStores) {
    const stores = createStores(injectedStores)
    const request = context.request
    const method = request.method.toUpperCase()
    const path = routePath(request)

    try {
        if (method === 'OPTIONS') return new Response(null, { status: 204 })
        if (method === 'GET' && (path === '' || path === 'health')) {
            return apiResponse({ service: 'elytrue-edgeone', status: 'ok' })
        }

        if (method === 'POST' && path === 'user/register') return await register(context, stores)
        if (method === 'POST' && path === 'user/login') return await login(context, stores)
        if (method === 'POST' && path === 'user/logout') return await logout(context, stores)
        if (method === 'POST' && path === 'user/resettoken') return await logout(context, stores, true)
        if (method === 'GET' && path === 'user/me') return await getMe(context, stores)
        if (method === 'GET' && path === 'user/find') return await findUsers(context, stores)
        if (method === 'PUT' && path === 'user/update') return await updateProfile(context, stores)
        if (method === 'POST' && path === 'user/resetpassword') return await requestPasswordReset(context, stores)
        if (method === 'POST' && path === 'action') return await completePasswordReset(context, stores)

        if (method === 'POST' && path === 'uploads/image') return await uploadCommentImage(context, stores)
        if (method === 'GET' && path === 'data/images/defaultAvatar.png') {
            return Response.redirect(new URL('/res/favicon-320.png', request.url), 302)
        }
        if (method === 'GET' && path.startsWith('data/images/avatars/')) {
            return await serveImage(stores, 'avatars', path.slice('data/images/avatars/'.length))
        }
        if (method === 'GET' && path.startsWith('data/images/posts/')) {
            const imageId = path.slice('data/images/posts/'.length).replace(/\.[a-z0-9]+$/iu, '')
            return await serveImage(stores, 'comments', imageId)
        }

        if (method === 'GET' && path === 'comments') return await getComments(context, stores)
        if (method === 'GET' && path === 'comments/count') return await commentsCount(context, stores)
        if (method === 'POST' && path === 'comments/post') return await postComment(context, stores)
        if (method === 'POST' && path === 'comments/like') return await likeComment(context, stores, true)
        if (method === 'DELETE' && path === 'comments/like') return await likeComment(context, stores, false)
        if (method === 'POST' && path === 'comments/report') return await reportComment(context, stores)

        if (method === 'POST' && path === 'admin/bootstrap') return await bootstrapAdmin(context, stores)
        if (method === 'GET' && path === 'admin/reports') return await adminReports(context, stores)
        if (method === 'POST' && path === 'admin/comments/moderate') return await adminModerate(context, stores)
        if (method === 'GET' && path === 'admin/usage') return await adminUsage(context, stores)

        return errorResponse(404, '接口不存在')
    } catch (error) {
        if (Number.isInteger(error?.status)) {
            return errorResponse(error.status, error.message, error.code || error.status)
        }
        console.error('Unhandled API error', {
            path,
            method,
            message: error?.message,
            stack: error?.stack,
        })
        return errorResponse(500, '服务器暂时无法处理请求')
    }
}
