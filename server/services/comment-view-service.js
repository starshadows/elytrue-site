import { randomUUID } from 'node:crypto'
import { blobKeys } from '../domain/blob-keys.js'
import { mapWithConcurrency } from '../lib/concurrency.js'
import { createCommentRepository } from '../repositories/comment-repository.js'
import { getJSON, getJSONPublic } from '../storage.js'

export const COMMENT_READ_CONCURRENCY = 8
export const LATEST_COMMENT_COUNT = 12
export const COMMENT_VIEW_VERSION = 1
const latestRefreshQueues = new WeakMap()

function measure(timing, category, operation) {
    return timing?.measure(category, operation) ?? operation()
}

/** @param {any} comment @param {number | null} [fallbackId] */
export function replyPreview(comment, fallbackId = null) {
    if (!comment) {
        return {
            displayId: fallbackId || 0,
            sender: '',
            avatar: '',
            comment: '留言已删除',
            deleted: true,
        }
    }
    return {
        id: comment.id,
        number: comment.number,
        displayId: comment.number,
        sender: comment.sender || '',
        avatar: comment.avatar || '',
        comment: comment.comment || '',
    }
}

export function toCommentCard(comment) {
    return {
        id: comment.id,
        number: comment.number,
        displayId: comment.number,
        uid: comment.uid,
        sender: comment.sender || '',
        avatar: comment.avatar || '',
        comment: comment.comment || '',
        image: comment.image || '',
        replyid: comment.replyid ?? null,
        hidden: Boolean(comment.hidden),
        likes: Math.max(0, Number(comment.likes) || 0),
        liked: false,
        createdAt: comment.createdAt,
        time: comment.time,
        ...(comment.replyPreview ? { replyPreview: comment.replyPreview } : {}),
    }
}

export function isCommentCard(value) {
    return Boolean(
        value
        && Number.isSafeInteger(Number(value.id))
        && Number.isSafeInteger(Number(value.number))
        && Number(value.number) > 0
        && typeof value.uid === 'string'
        && typeof value.comment === 'string'
        && Number.isFinite(Number(value.time)),
    )
}

/** @param {any} value @param {string | null} [expectedDate] */
export function isLatestCommentView(value, expectedDate = null) {
    return Boolean(
        value
        && value.version === COMMENT_VIEW_VERSION
        && Array.isArray(value.items)
        && value.items.length <= LATEST_COMMENT_COUNT
        && value.items.every(isCommentCard)
        && Number.isFinite(Number(value.generatedAt))
        && Number.isSafeInteger(Number(value.todayCount))
        && Number(value.todayCount) >= 0
        && (!expectedDate || value.date === expectedDate),
    )
}

export function publicViewId(key) {
    const match = /-(\d{16})\.json$/u.exec(String(key))
    return match ? Number(match[1]) : null
}

export function userViewId(key) {
    return publicViewId(key)
}

export async function markCommentViewRepair(data, commentId, reason, error, details = {}) {
    const repository = createCommentRepository(data)
    await repository.setRepair(commentId, {
        commentId,
        reason,
        status: 'open',
        updatedAt: Date.now(),
        error: String(error?.message || error).slice(0, 300),
        ...details,
    }).catch(markerError => {
        console.error(JSON.stringify({
            event: 'comment_view_repair_marker_failed',
            commentId,
            reason,
            error: String(markerError?.message || markerError).slice(0, 300),
        }))
    })
}

export async function writeCommentViews(data, comment) {
    const repository = createCommentRepository(data)
    const card = toCommentCard(comment)
    const writes = [
        repository.setUserView(comment.uid, comment.id, card),
        comment.hidden
            ? repository.deletePublicView(comment.id)
            : repository.setPublicView(comment.id, card),
        comment.hidden
            ? repository.setHiddenView(comment.id, card)
            : repository.deleteHiddenView(comment.id),
    ]
    const results = await Promise.allSettled(writes)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return card
}

export async function hideCommentViews(data, comment) {
    const repository = createCommentRepository(data)
    const card = toCommentCard({ ...comment, hidden: true })
    // The public key is gated first. If delete fails, public readers still skip it.
    await repository.setPublicView(comment.id, card)
    const results = await Promise.allSettled([
        repository.setUserView(comment.uid, comment.id, card),
        repository.setHiddenView(comment.id, card),
    ])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    await repository.deletePublicView(comment.id)
    return card
}

export async function listPublicViewKeys(data, { publicRead = false } = {}) {
    const response = await data.list({
        prefix: blobKeys.commentPublicViewsPrefix,
        limit: Infinity,
        consistency: publicRead ? 'eventual' : 'strong',
    })
    return response?.blobs || []
}

export async function listHiddenViewKeys(data) {
    const response = await data.list({
        prefix: blobKeys.commentHiddenViewsPrefix,
        limit: Infinity,
        consistency: 'strong',
    })
    return response?.blobs || []
}

export async function loadPublicCards(data, blobs, { publicRead = false, includeHidden = false, timing = null } = {}) {
    const readJSON = publicRead ? getJSONPublic : getJSON
    return measure(timing, 'commentBodies', async () => {
        const values = await mapWithConcurrency(
            blobs,
            blob => readJSON(data, blob.key),
            COMMENT_READ_CONCURRENCY,
        )
        return values.filter(isCommentCard).filter(comment => includeHidden || !comment.hidden)
    })
}

export async function countPublishedOnDate(data, date, publicRead = false) {
    const result = await data.list({
        prefix: blobKeys.commentsByDatePrefix(date),
        limit: Infinity,
        consistency: publicRead ? 'eventual' : 'strong',
    })
    return (result?.blobs || []).length
}

export async function buildLatestCommentView(data, date, timing = null) {
    const blobs = await measure(timing, 'readView', () => listPublicViewKeys(data))
    const selected = blobs.slice(0, LATEST_COMMENT_COUNT)
    const [items, todayCount] = await Promise.all([
        loadPublicCards(data, selected, { timing }),
        measure(timing, 'todayCount', () => countPublishedOnDate(data, date)),
    ])
    return {
        version: COMMENT_VIEW_VERSION,
        date,
        generatedAt: Date.now(),
        todayCount,
        items,
        hasMore: blobs.length > selected.length,
        nextCursor: blobs.length > selected.length && items.length > 0
            ? items.at(-1).id
            : null,
    }
}

export async function withLatestViewLock(data, operation) {
    const previous = latestRefreshQueues.get(data) || Promise.resolve()
    const refresh = previous.then(async () => {
        const owner = randomUUID()
        let claimed = false
        for (let attempt = 0; attempt < 20 && !claimed; attempt += 1) {
            try {
                await data.setJSON(blobKeys.commentsLatestLock, {
                    owner,
                    createdAt: Date.now(),
                }, { onlyIfNew: true })
                claimed = true
            } catch (error) {
                if (error?.name !== 'PreconditionFailedError'
                    && error?.code !== 'PRECONDITION_FAILED'
                    && error?.statusCode !== 412) throw error
                const lock = await getJSON(data, blobKeys.commentsLatestLock).catch(() => null)
                if (lock && Date.now() - Number(lock.createdAt || 0) > 60_000) {
                    await data.delete(blobKeys.commentsLatestLock).catch(() => {})
                }
                await new Promise(resolve => setTimeout(resolve, 5))
            }
        }
        if (!claimed) throw new Error('latest view lock is busy')
        try {
            return await operation()
        } finally {
            const lock = await getJSON(data, blobKeys.commentsLatestLock).catch(() => null)
            if (lock?.owner === owner) await data.delete(blobKeys.commentsLatestLock).catch(() => {})
        }
    })
    const queued = refresh.then(() => {}, () => {})
    latestRefreshQueues.set(data, queued)
    try {
        return await refresh
    } finally {
        if (latestRefreshQueues.get(data) === queued) latestRefreshQueues.delete(data)
    }
}

export async function mutateCommentViewsAndRefresh(data, date, mutation, timing = null) {
    return withLatestViewLock(data, async () => {
        const repository = createCommentRepository(data)
        await repository.deleteLatest().catch(() => {})
        try {
            await mutation()
        } catch (error) {
            if (error && typeof error === 'object') error.commentViewStage = 'views'
            throw error
        }
        let view
        try {
            view = await buildLatestCommentView(data, date, timing)
            await repository.setLatest(view)
        } catch (error) {
            if (error && typeof error === 'object') error.commentViewStage = 'latest'
            throw error
        }
        return view
    })
}

export async function refreshLatestCommentView(data, date, timing = null) {
    return mutateCommentViewsAndRefresh(data, date, () => {}, timing)
}
