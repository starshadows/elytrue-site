import { countComments, listComments } from '../../comments.js'
import { environmentFor } from '../../middleware/request-context.js'
import { authenticatedProfile, timedApiResponse } from '../handler-response.js'

export async function bootstrap(context, stores, path, auth) {
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
