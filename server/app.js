import {
    authenticateUser,
    createSession,
    destroySession,
    findUserById,
    findUserByIdentifier,
    privateProfile,
    registerUser,
    revokeAllSessions,
    updateUser,
} from './auth.js'
import {
    createComment,
    countComments,
    listComments,
    setLike,
} from './comments.js'
import {
    apiResponse,
    binaryResponse,
    errorResponse,
    httpError,
    parseCookies,
    readJSON,
} from './http.js'
import { enforceRateLimit } from './rate-limit.js'
import { sha256 } from './crypto.js'
import { createStores } from './storage.js'
import {
    clientIdentity,
    environmentFor,
} from './middleware/request-context.js'
import { API_ROUTES, matchApiRoute, validateApiRouteRegistry } from './routes/registry.js'
import { enforceRoutePolicy } from './routes/policy.js'
import { apiRoutePath } from './lib/routing.js'
import { attachServerTiming, createServerTiming } from './lib/server-timing.js'
import { createReport } from './services/report-service.js'

let imageServicePromise = null
let accountRecoveryServicePromise = null
let adminServicePromise = null

function loadImageService() {
    imageServicePromise ??= import('./services/image-service.js')
    return imageServicePromise.catch(error => {
        imageServicePromise = null
        throw error
    })
}

function loadAccountRecoveryService() {
    accountRecoveryServicePromise ??= import('./services/account-recovery-service.js')
    return accountRecoveryServicePromise.catch(error => {
        accountRecoveryServicePromise = null
        throw error
    })
}

function loadAdminService() {
    adminServicePromise ??= import('./services/admin-service.js')
    return adminServicePromise.catch(error => {
        adminServicePromise = null
        throw error
    })
}

// server/build-info.js 由 scripts/gen-build-info.mjs 在构建时生成(被 gitignore),
// 本地测试/开发时不存在,回退为 dev 默认值。
let buildInfoPromise = null
async function loadBuildInfo() {
    if (!buildInfoPromise) {
        buildInfoPromise = import('./build-info.js')
            .then(module => ({
                version: module.BUILD_VERSION,
                buildTime: module.BUILD_TIME,
                commitTime: module.COMMIT_TIME,
            }))
            .catch(() => ({ version: 'dev', buildTime: null, commitTime: null }))
    }
    return buildInfoPromise
}

function authenticatedProfile(user, env, session) {
    return {
        ...privateProfile(user, env),
        csrfToken: session.csrfToken,
    }
}

async function serveImage(stores, kind, imageId) {
    const { loadImage } = await loadImageService()
    const image = await loadImage(stores, kind, imageId)
    return binaryResponse(image.buffer, image.contentType, {
        cache: 'public, max-age=31536000, immutable',
    })
}

function timedApiResponse(context, data, options) {
    const operation = () => apiResponse(data, options)
    return context.requestTiming?.measureSync('serialization', operation) ?? operation()
}

async function register(context, stores) {
    await enforceRateLimit('register', clientIdentity(context))
    const body = await readJSON(context.request, 32 * 1024)
    const { user, recoveryKey } = await registerUser(stores.data, environmentFor(context), {
        name: body.name,
        email: body.email,
        password: body.password,
    })
    const { session, cookies } = await createSession(
        stores.data,
        user,
        context.request,
        environmentFor(context),
    )
    return apiResponse({
        ...authenticatedProfile(user, environmentFor(context), session),
        recoveryKey,
    }, {
        status: 201,
        message: '注册成功',
        cookies,
    })
}

async function login(context, stores) {
    const body = await readJSON(context.request, 32 * 1024)
    const identifier = body.identifier || body.email || body.name || ''
    await enforceRateLimit('login', clientIdentity(context, String(identifier).toLowerCase()))
    const user = await authenticateUser(
        stores.data,
        environmentFor(context),
        identifier,
        body.password || '',
    )
    const { session, cookies } = await createSession(
        stores.data,
        user,
        context.request,
        environmentFor(context),
    )
    return apiResponse(authenticatedProfile(user, environmentFor(context), session), {
        message: '登录成功',
        cookies,
    })
}

async function logout(context, stores, path, auth, allDevices = false) {
    await enforceRateLimit(
        allDevices ? 'logoutAll' : 'logout',
        clientIdentity(context, auth.user.id),
    )
    if (allDevices) await revokeAllSessions(stores.data, auth.user)
    const cookies = await destroySession(
        stores.data,
        context.request,
        auth,
        environmentFor(context),
    )
    return apiResponse(null, { message: '已退出登录', cookies })
}

async function getMe(context, stores, path, auth) {
    if (!auth) {
        if (parseCookies(context.request).elytrue_session) throw httpError(401, '请先登录')
        return timedApiResponse(context, null)
    }
    return timedApiResponse(
        context,
        authenticatedProfile(auth.user, environmentFor(context), auth.session),
        { cookies: auth.refreshCookies },
    )
}

async function findUsers(context, stores) {
    const url = new URL(context.request.url)
    const id = url.searchParams.get('id')
    const name = url.searchParams.get('name')
    let user = null
    if (id) user = await findUserById(stores.data, id)
    else if (name && !name.includes('@'))
        user = await findUserByIdentifier(stores.data, environmentFor(context), name)
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

async function updateProfile(context, stores, path, auth) {
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

async function recoverUser(context, stores) {
    const body = await readJSON(context.request, 32 * 1024)
    const identifier = String(body.identifier || '').normalize('NFKC').trim().toLowerCase()
    await enforceRateLimit('recoverIp', clientIdentity(context))
    await enforceRateLimit('recoverAccount', `account:${sha256(identifier)}`)
    const { recoverAccount } = await loadAccountRecoveryService()
    const result = await recoverAccount(stores.data, environmentFor(context), {
        identifier,
        recoveryKey: body.recoveryKey,
        password: body.password,
    })
    return apiResponse(result, { message: '账号已恢复，请使用新密码重新登录' })
}

async function updateRecoveryKey(context, stores, path, auth) {
    await enforceRateLimit('recoveryKey', `user:${sha256(auth.user.id)}`)
    const body = await readJSON(context.request, 32 * 1024)
    const { rotateRecoveryKey } = await loadAccountRecoveryService()
    const result = await rotateRecoveryKey(stores.data, auth.user, body.currentPassword)
    return apiResponse(result, { message: '恢复密钥已更新，旧密钥已失效' })
}

async function uploadCommentImage(context, stores, path, auth) {
    await enforceRateLimit('upload', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 3 * 1024 * 1024)
    const { cleanupStalePendingImages, saveImage } = await loadImageService()
    const saved = await saveImage(stores, auth.user, body.image, 'comment')
    await cleanupStalePendingImages(stores, auth.user)
    return apiResponse({ imageId: saved.imageId }, { status: 201, message: '图片已上传' })
}

async function deleteUploadedImage(context, stores, path, auth) {
    await enforceRateLimit('upload', clientIdentity(context, auth.user.id))
    const imageId = String(new URL(context.request.url).searchParams.get('imageId') || '')
    const { deletePendingImage } = await loadImageService()
    await deletePendingImage(stores, auth.user, imageId)
    return apiResponse(null, { message: '图片已删除' })
}

async function postComment(context, stores, path, auth) {
    await enforceRateLimit('comment', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 64 * 1024)
    const comment = await context.commentTiming.measure('commentBodies', () =>
        createComment(stores.data, auth.user, body, { timing: context.commentTiming }))
    return apiResponse(comment, { status: 201, message: '留言已发布' })
}

async function getComments(context, stores, path, auth) {
    const url = new URL(context.request.url)
    const params = url.searchParams
    const isInitialPage = params.get('uid') === null
        && params.get('cursor') === null
        && params.get('number') === null
        && params.get('time') === null
        && params.get('from') === null
    const todayCountRequest = isInitialPage
        ? context.commentTiming.measure('todayCount', () => countComments(stores.data, params))
        : null
    const commentsRequest = listComments(stores.data, params, auth?.user, {
        timing: context.commentTiming,
    })
    let result
    let todayCount
    if (todayCountRequest) {
        [result, todayCount] = await Promise.all([commentsRequest, todayCountRequest])
    } else {
        result = await commentsRequest
    }
    // 用户列表:{ items, hasMore, nextCursor };主列表:数组(scanCap 截断时返回 { items, hasMore })
    if (Array.isArray(result)) {
        return timedApiResponse(context, result, { cookies: auth?.refreshCookies || [] })
    }
    if (params.get('uid')) {
        return timedApiResponse(context, result, { cookies: auth?.refreshCookies || [] })
    }
    // 首次主页列表合并今日留言数量,避免额外的 /comments/count 请求;
    // 跳转(number/time/from)与分页(cursor)请求保持原有形态。
    if (isInitialPage) {
        return timedApiResponse(context, {
            items: result.items,
            hasMore: result.hasMore,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            todayCount,
        }, { cookies: auth?.refreshCookies || [] })
    }
    if (result.hasMore) {
        return timedApiResponse(context, {
            items: result.items,
            hasMore: true,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        }, { cookies: auth?.refreshCookies || [] })
    }
    return timedApiResponse(context, result.items, { cookies: auth?.refreshCookies || [] })
}

async function bootstrap(context, stores, path, auth) {
    const params = new URLSearchParams({ count: '12' })
    const profile = auth
        ? authenticatedProfile(auth.user, environmentFor(context), auth.session)
        : null
    const [commentsResult, todayCountResult] = await Promise.allSettled([
        listComments(stores.data, params, auth?.user, {
            timing: context.commentTiming,
        }),
        context.commentTiming.measure('todayCount', () => countComments(stores.data, params)),
    ])
    if (commentsResult.status === 'rejected') {
        console.error(JSON.stringify({
            event: 'bootstrap_comments_failed',
            message: commentsResult.reason instanceof Error
                ? commentsResult.reason.message
                : String(commentsResult.reason),
        }))
    }
    if (todayCountResult.status === 'rejected') {
        console.error(JSON.stringify({
            event: 'bootstrap_today_count_failed',
            message: todayCountResult.reason instanceof Error
                ? todayCountResult.reason.message
                : String(todayCountResult.reason),
        }))
    }
    const comments = commentsResult.status === 'fulfilled'
        ? commentsResult.value
        : null
    return timedApiResponse(context, {
        profile,
        ...(profile ? { csrfToken: profile.csrfToken } : {}),
        todayCount: todayCountResult.status === 'fulfilled'
            ? todayCountResult.value
            : null,
        comments: comments ? {
            items: comments.items,
            hasMore: comments.hasMore,
            ...(comments.nextCursor ? { nextCursor: comments.nextCursor } : {}),
            ...(todayCountResult.status === 'fulfilled'
                ? { todayCount: todayCountResult.value }
                : {}),
        } : null,
        ...(comments ? {} : { commentsError: true }),
    }, { cookies: auth?.refreshCookies || [] })
}

async function commentsCount(context, stores) {
    const url = new URL(context.request.url)
    const count = await context.commentTiming.measure(
        'todayCount',
        () => countComments(stores.data, url.searchParams),
    )
    return timedApiResponse(context, count)
}

async function likeComment(context, stores, path, auth, liked) {
    await enforceRateLimit('like', clientIdentity(context, auth.user.id))
    const commentId = Number(new URL(context.request.url).searchParams.get('commentId'))
    if (!Number.isSafeInteger(commentId)) throw httpError(400, '留言编号无效')
    const result = await setLike(stores.data, commentId, auth.user, liked, {
        timing: context.commentTiming,
    })
    return apiResponse(result, { message: liked ? '已点赞' : '已取消点赞' })
}

async function reportComment(context, stores, path, auth) {
    await enforceRateLimit('report', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 16 * 1024)
    const commentId = Number(body.commentId || new URL(context.request.url).searchParams.get('commentId'))
    await createReport(stores.data, commentId, auth.user, body.reason)
    return apiResponse(null, { message: '举报已提交' })
}

async function bootstrapAdmin(context, stores, path, auth) {
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

async function adminReports(context, stores, path, auth) {
    await enforceRateLimit('admin', clientIdentity(context, auth.user.id))
    const { getAdminReports } = await loadAdminService()
    return apiResponse(await getAdminReports(stores.data))
}

async function adminModerate(context, stores, path, auth) {
    await enforceRateLimit('admin', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 16 * 1024)
    const { moderateAdminComment } = await loadAdminService()
    await moderateAdminComment(stores.data, Number(body.commentId), body.action)
    return apiResponse(null, { message: '管理操作已完成' })
}

async function adminUsage(context, stores, path, auth) {
    await enforceRateLimit('admin', clientIdentity(context, auth.user.id))
    const { getAdminUsage } = await loadAdminService()
    return apiResponse(await getAdminUsage(stores))
}

export const API_ROUTE_HANDLERS = Object.freeze({
    health: async () => {
        const build = await loadBuildInfo()
        return apiResponse({
            service: 'elytrue-edgeone',
            status: 'ok',
            version: build.version,
            buildTime: build.buildTime,
            commitTime: build.commitTime,
        })
    },
    register,
    login,
    logout,
    logoutAll: (context, stores, path, auth) => logout(context, stores, path, auth, true),
    me: getMe,
    bootstrap,
    findUsers,
    updateProfile,
    recoverUser,
    updateRecoveryKey,
    uploadImage: uploadCommentImage,
    deleteImage: deleteUploadedImage,
    defaultAvatar: context =>
        Response.redirect(new URL('/res/favicon-320.png', context.request.url), 302),
    avatarImage: (context, stores, path) =>
        serveImage(stores, 'avatars', path.slice('data/images/avatars/'.length)),
    commentImage: (context, stores, path) =>
        serveImage(
            stores,
            'comments',
            path.slice('data/images/posts/'.length).replace(/\.[a-z0-9]+$/iu, ''),
        ),
    comments: getComments,
    commentCount: commentsCount,
    postComment,
    likeComment: (context, stores, path, auth) => likeComment(context, stores, path, auth, true),
    unlikeComment: (context, stores, path, auth) => likeComment(context, stores, path, auth, false),
    reportComment,
    bootstrapAdmin,
    adminReports,
    adminModerate,
    adminUsage,
})

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
            timing = createServerTiming()
            context.requestTiming = timing
            context.commentTiming = timing
        }
        const route = timing
            ? await timing.measure('routing', () => Promise.resolve(matchApiRoute(method, path)))
            : matchApiRoute(method, path)
        if (!route) return errorResponse(404, '接口不存在')
        const handler = API_ROUTE_HANDLERS[route.handler]
        if (!handler) throw new Error(`API route handler is not registered: ${route.handler}`)
        const auth = timing
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
