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
        }),
        }
    } catch (reason) {
        commentsResult = { status: 'rejected', reason }
    }
    const snapshotCount = commentsResult.status === 'fulfilled'
        && Number.isSafeInteger(commentsResult.value?.todayCount)
        ? commentsResult.value.todayCount
        : null
    /** @type {PromiseSettledResult<number>} */
    let todayCountResult
    if (snapshotCount !== null) {
        todayCountResult = { status: 'fulfilled', value: snapshotCount }
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
            ...(todayCountResult.status === 'fulfilled'
                ? { todayCount: todayCountResult.value }
                : {}),
        } : null,
        ...(comments ? {} : { commentsError: true }),
    }, { cookies: auth?.refreshCookies || [] })
}
