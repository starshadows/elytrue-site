import { countComments, listComments } from '../../comments.js'
import { environmentFor } from '../../middleware/request-context.js'
import { authenticatedProfile, timedApiResponse } from '../handler-response.js'

export async function bootstrap(context, stores, path, auth) {
    const params = new URLSearchParams({ count: '12' })
    const profile = auth
        ? authenticatedProfile(auth.user, environmentFor(context), auth.session)
        : null
    /** @type {PromiseSettledResult<any>} */
    let commentsResult
    try {
        commentsResult = {
            status: 'fulfilled',
            value: await listComments(stores.data, params, null, {
                timing: context.commentTiming,
                publicRead: true,
                preferLatest: true,
                includeTodayCount: true,
            }),
        }
    } catch (reason) {
        commentsResult = { status: 'rejected', reason }
    }
    const snapshotCount = commentsResult.status === 'fulfilled'
        && Number.isSafeInteger(commentsResult.value?.todayCount)
        ? commentsResult.value.todayCount
        : null
    const countWasIncluded = commentsResult.status === 'fulfilled'
        && Object.hasOwn(commentsResult.value || {}, 'todayCount')
    /** @type {PromiseSettledResult<number>} */
    let todayCountResult
    if (snapshotCount !== null) {
        todayCountResult = { status: 'fulfilled', value: snapshotCount }
    } else if (countWasIncluded && commentsResult.status === 'fulfilled') {
        todayCountResult = {
            status: 'rejected',
            reason: commentsResult.value.todayCountError
                || new Error('今日留言计数不可用'),
        }
    } else {
        try {
            todayCountResult = {
                status: 'fulfilled',
                value: await context.commentTiming.measure(
                'todayCount',
                () => countComments(stores.data, params, { publicRead: true }),
            ),
            }
        } catch (reason) {
            todayCountResult = { status: 'rejected', reason }
        }
    }
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
    const commentsValue = commentsResult.status === 'fulfilled'
        ? commentsResult.value
        : null
    const comments = Array.isArray(commentsValue)
        ? { items: commentsValue, hasMore: false }
        : commentsValue
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
            ...(Number.isFinite(comments.snapshotGeneratedAt)
                ? { snapshotGeneratedAt: comments.snapshotGeneratedAt }
                : {}),
            ...(Number.isSafeInteger(comments.snapshotRevision)
                ? { snapshotRevision: comments.snapshotRevision }
                : {}),
            ...(todayCountResult.status === 'fulfilled'
                ? { todayCount: todayCountResult.value }
                : {}),
        } : null,
        ...(comments ? {} : { commentsError: true }),
    }, { cookies: auth?.refreshCookies || [] })
}
