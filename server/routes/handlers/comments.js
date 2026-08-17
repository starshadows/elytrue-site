import {
    countComments,
    createComment,
    getCommentVisibility,
    getViewerLikeStates,
    listComments,
    setLike,
} from '../../comments.js'
import { createHash } from 'node:crypto'
import { apiResponse, httpError, readJSON } from '../../http.js'
import { enforceRateLimit } from '../../rate-limit.js'
import { clientIdentity } from '../../middleware/request-context.js'
import { createReport } from '../../services/report-service.js'
import { timedApiResponse } from '../handler-response.js'

export async function comments(
    context,
    stores,
    path,
    auth,
    publicRead = false,
    responseOptions = {},
) {
    const url = new URL(context.request.url)
    const params = url.searchParams
    const isInitialPage = params.get('uid') === null
        && params.get('cursor') === null
        && params.get('number') === null
        && params.get('time') === null
        && params.get('from') === null
    const result = await listComments(stores.data, params, auth?.user, {
        timing: context.commentTiming,
        publicRead,
        preferLatest: !publicRead && isInitialPage,
        includeTodayCount: publicRead && isInitialPage,
    })
    // 用户列表:{ items, hasMore, nextCursor };主列表:数组(scanCap 截断时返回 { items, hasMore })
    if (Array.isArray(result)) {
        return timedApiResponse(context, result, {
            ...responseOptions,
            cookies: auth?.refreshCookies || [],
        })
    }
    if (params.get('uid')) {
        return timedApiResponse(context, result, {
            ...responseOptions,
            cookies: auth?.refreshCookies || [],
        })
    }
    if (isInitialPage) {
        return timedApiResponse(context, {
            items: result.items,
            hasMore: result.hasMore,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            ...(Number.isSafeInteger(result.todayCount)
                ? { todayCount: result.todayCount }
                : {}),
            ...(Number.isFinite(result.snapshotGeneratedAt)
                ? { snapshotGeneratedAt: result.snapshotGeneratedAt }
                : {}),
            ...(Number.isSafeInteger(result.snapshotRevision)
                ? { snapshotRevision: result.snapshotRevision }
                : {}),
        }, { ...responseOptions, cookies: auth?.refreshCookies || [] })
    }
    if (result.hasMore) {
        return timedApiResponse(context, {
            items: result.items,
            hasMore: true,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        }, { ...responseOptions, cookies: auth?.refreshCookies || [] })
    }
    return timedApiResponse(context, result.items, {
        ...responseOptions,
        cookies: auth?.refreshCookies || [],
    })
}

export async function publicComments(context, stores) {
    const params = new URL(context.request.url).searchParams
    if ([...params.keys()].some(key => key !== 'count')) {
        throw httpError(400, '公共首屏留言参数无效')
    }
    return comments(context, stores, 'comments/public', null, true, {
        headers: {
            'Cache-Control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30',
        },
    })
}

export async function commentVisibility(context, stores) {
    const params = new URL(context.request.url).searchParams
    if ([...params.keys()].some(key => key !== 'ids')) {
        throw httpError(400, '留言可见性参数无效')
    }
    const rawIds = params.get('ids') || ''
    const values = rawIds.split(',').filter(Boolean)
    const ids = [...new Set(values.map(Number))]
    if (
        values.length === 0
        || ids.length > 10
        || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    ) {
        throw httpError(400, '留言 ID 参数无效')
    }
    await enforceRateLimit('visibility', clientIdentity(context))
    return timedApiResponse(
        context,
        await getCommentVisibility(stores.data, ids),
        { headers: { 'Cache-Control': 'no-store' } },
    )
}

export async function commentCount(context, stores) {
    const url = new URL(context.request.url)
    const count = await context.commentTiming.measure(
        'todayCount',
        () => countComments(stores.data, url.searchParams, { publicRead: true }),
    )
    return timedApiResponse(context, count)
}

export async function viewerLikes(context, stores, path, auth) {
    const rawIds = new URL(context.request.url).searchParams.get('ids') || ''
    const ids = [...new Set(rawIds.split(',').filter(Boolean).map(Number))]
    if (
        ids.length > 20
        || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    ) {
        throw httpError(400, '留言 ID 参数无效')
    }
    const states = await getViewerLikeStates(
        stores.data,
        ids,
        auth.user,
        context.commentTiming,
    )
    return timedApiResponse(context, states, { cookies: auth.refreshCookies })
}

export async function postComment(context, stores, path, auth) {
    const user = auth?.user ?? null
    const identity = user?.id ?? 'guest'
    await enforceRateLimit('comment', clientIdentity(context, identity))
    const body = await readJSON(context.request, 64 * 1024)
    const forbiddenFields = [
        'uid', 'sender', 'role', 'admin', 'createdAt', 'time', 'id', 'number',
    ]
    if (forbiddenFields.some(field => Object.hasOwn(body, field))) {
        throw httpError(400, '留言包含不允许的身份字段')
    }
    const idempotencyKey = context.request.headers.get('X-Idempotency-Key')
    const operationId = idempotencyKey
        ? `create-${createHash('sha256')
            .update(`${clientIdentity(context, identity)}\0${idempotencyKey}`)
            .digest('hex')}`
        : null
    const comment = await context.commentTiming.measure('commentBodies', () =>
        createComment(stores.data, user, body, {
            timing: context.commentTiming,
            operationId,
        }))
    return apiResponse(comment, { status: 201, message: '留言已发布' })
}

async function updateLike(context, stores, auth, liked) {
    await enforceRateLimit('like', clientIdentity(context, auth.user.id))
    const commentId = Number(new URL(context.request.url).searchParams.get('commentId'))
    if (!Number.isSafeInteger(commentId)) throw httpError(400, '留言编号无效')
    const result = await setLike(stores.data, commentId, auth.user, liked, {
        timing: context.commentTiming,
    })
    return apiResponse(result, { message: liked ? '已点赞' : '已取消点赞' })
}

export function likeComment(context, stores, path, auth) {
    return updateLike(context, stores, auth, true)
}

export function unlikeComment(context, stores, path, auth) {
    return updateLike(context, stores, auth, false)
}

export async function reportComment(context, stores, path, auth) {
    await enforceRateLimit('report', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 16 * 1024)
    const commentId = Number(body.commentId || new URL(context.request.url).searchParams.get('commentId'))
    await createReport(stores.data, commentId, auth.user, body.reason)
    return apiResponse(null, { message: '举报已提交' })
}
