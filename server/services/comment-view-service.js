import { randomUUID } from 'node:crypto'
import { blobKeys } from '../domain/blob-keys.js'
import { mapWithConcurrency } from '../lib/concurrency.js'
import { createCommentRepository } from '../repositories/comment-repository.js'
import { getJSON, getJSONPublic } from '../storage.js'

export const COMMENT_READ_CONCURRENCY = 8
export const LATEST_COMMENT_COUNT = 12
export const LATEST_COMMENT_SCAN_LIMIT = 25
export const COMMENT_VIEW_VERSION = 1
export const DAILY_COMMENT_COUNT_VERSION = 1
export const LATEST_COMMENT_REVISION_VERSION = 1
const latestRefreshQueues = new WeakMap()
const LATEST_LOCK_STALE_MS = 60_000
const LATEST_LOCK_WAIT_MS = 3_000
const LATEST_LOCK_INITIAL_BACKOFF_MS = 20
const LATEST_LOCK_MAX_BACKOFF_MS = 250

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
        && (typeof value.uid === 'string' || value.uid === null)
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
        && (value.snapshotRevision === undefined
            || (Number.isSafeInteger(Number(value.snapshotRevision))
                && Number(value.snapshotRevision) > 0))
        && Number.isSafeInteger(Number(value.todayCount))
        && Number(value.todayCount) >= 0
        && (!expectedDate || value.date === expectedDate),
    )
}

export function isLatestCommentRevision(value) {
    return Boolean(
        value
        && value.version === LATEST_COMMENT_REVISION_VERSION
        && Number.isSafeInteger(Number(value.revision))
        && Number(value.revision) > 0
        && Number.isFinite(Number(value.updatedAt)),
    )
}

/** @param {any} value @param {string | null} [expectedDate] */
export function isDailyCommentCount(value, expectedDate = null) {
    return Boolean(
        value
        && value.version === DAILY_COMMENT_COUNT_VERSION
        && Number.isSafeInteger(Number(value.count))
        && Number(value.count) >= 0
        && Number.isFinite(Number(value.updatedAt))
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
        ...(comment.uid ? [repository.setUserView(comment.uid, comment.id, card)] : []),
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
        ...(comment.uid ? [repository.setUserView(comment.uid, comment.id, card)] : []),
        repository.setHiddenView(comment.id, card),
    ])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    await repository.deletePublicView(comment.id)
    return card
}

/**
 * @param {any} data
 * @param {{publicRead?: boolean, limit?: number, paginate?: boolean}} [options]
 */
export async function listPublicViewKeys(
    data,
    { publicRead = false, limit = Infinity, paginate } = {},
) {
    const response = await data.list({
        prefix: blobKeys.commentPublicViewsPrefix,
        limit,
        ...(typeof paginate === 'boolean' ? { paginate } : {}),
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

/**
 * @param {any} data
 * @param {string} date
 * @param {{publicRead?: boolean, timing?: any, views?: any[], persistRecovery?: boolean}} [options]
 */
export async function resolvePublishedCount(
    data,
    date,
    { publicRead = false, timing = null, views = [], persistRecovery = !publicRead } = {},
) {
    return measure(timing, 'todayCount', async () => {
        const snapshot = views.find(view => isLatestCommentView(view, date))
        if (snapshot) return Number(snapshot.todayCount)

        const repository = createCommentRepository(data)
        const daily = await repository.getDailyCount(date, publicRead).catch(() => null)
        if (isDailyCommentCount(daily, date)) return Number(daily.count)

        const count = await countPublishedOnDate(data, date, publicRead)
        if (persistRecovery) {
            await repository.setDailyCount(date, {
                version: DAILY_COMMENT_COUNT_VERSION,
                date,
                count,
                updatedAt: Date.now(),
            })
        }
        return count
    })
}

export async function buildLatestCommentView(
    data,
    date,
    timing = null,
    suppliedTodayCount,
    snapshotRevision,
) {
    const blobs = await measure(timing, 'readView', () => listPublicViewKeys(data, {
        limit: LATEST_COMMENT_SCAN_LIMIT,
        paginate: false,
    }))
    const visible = await loadPublicCards(data, blobs, { timing })
    const items = visible.slice(0, LATEST_COMMENT_COUNT)
    const todayCount = suppliedTodayCount ?? await resolvePublishedCount(data, date, {
        timing,
    })
    const hasMore = blobs.length >= LATEST_COMMENT_SCAN_LIMIT
        || visible.length > LATEST_COMMENT_COUNT
    return {
        version: COMMENT_VIEW_VERSION,
        date,
        generatedAt: Date.now(),
        ...(Number.isSafeInteger(snapshotRevision) ? { snapshotRevision } : {}),
        todayCount,
        items,
        hasMore,
        nextCursor: hasMore && items.length > 0
            ? items.at(-1).id
            : null,
    }
}

async function allocateSnapshotRevision(repository, ...views) {
    const counter = await repository.getLatestRevision()
    if (counter !== null && !isLatestCommentRevision(counter)) {
        throw new Error('latest view revision is corrupt')
    }
    const baseline = Math.max(
        Number(counter?.revision || 0),
        ...views.map(view => Number.isSafeInteger(Number(view?.snapshotRevision))
            ? Number(view.snapshotRevision)
            : 0),
    )
    const revision = baseline + 1
    if (!Number.isSafeInteger(revision)) {
        throw new Error('latest view revision is exhausted')
    }
    await repository.setLatestRevision({
        version: LATEST_COMMENT_REVISION_VERSION,
        revision,
        updatedAt: Date.now(),
    })
    return revision
}

function isPreconditionFailure(error) {
    return error?.name === 'PreconditionFailedError'
        || error?.code === 'PRECONDITION_FAILED'
        || error?.statusCode === 412
}

function wait(delay) {
    return new Promise(resolve => setTimeout(resolve, delay))
}

async function acquireLatestViewLock(data, owner) {
    const deadline = performance.now() + LATEST_LOCK_WAIT_MS
    let backoff = LATEST_LOCK_INITIAL_BACKOFF_MS
    while (performance.now() < deadline) {
        try {
            await data.setJSON(blobKeys.commentsLatestLock, {
                owner,
                createdAt: Date.now(),
            }, { onlyIfNew: true })
            return
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            const lock = await getJSON(data, blobKeys.commentsLatestLock).catch(() => null)
            if (lock && Date.now() - Number(lock.createdAt || 0) > LATEST_LOCK_STALE_MS) {
                await data.delete(blobKeys.commentsLatestLock).catch(() => {})
                continue
            }
            const remaining = deadline - performance.now()
            if (remaining <= 0) break
            const minimum = backoff / 2
            const jittered = minimum + Math.random() * minimum
            await wait(Math.min(remaining, jittered))
            backoff = Math.min(LATEST_LOCK_MAX_BACKOFF_MS, backoff * 2)
        }
    }
    throw new Error('latest view lock is busy')
}

export async function withLatestViewLock(data, operation, timing = null) {
    const previous = latestRefreshQueues.get(data) || Promise.resolve()
    const refresh = previous.then(async () => {
        const owner = randomUUID()
        await measure(timing, 'latestLock', () => acquireLatestViewLock(data, owner))
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

function guardLatestView(
    view,
    date,
    todayCount,
    excludedCommentId,
    snapshotRevision,
) {
    const items = view.items.filter(item => item.id !== excludedCommentId)
    const removed = items.length !== view.items.length
    const hasMore = Boolean(view.hasMore) && (removed || items.length > 0)
    return {
        ...view,
        date,
        generatedAt: Date.now(),
        snapshotRevision,
        todayCount,
        items,
        hasMore,
        nextCursor: hasMore && items.length > 0 ? items.at(-1).id : null,
    }
}

function patchLatestView(view, date, todayCount, comment, snapshotRevision) {
    const card = toCommentCard(comment)
    return {
        ...view,
        date,
        generatedAt: Date.now(),
        snapshotRevision,
        todayCount,
        items: view.items.map(item => item.id === card.id ? card : item),
    }
}

async function mutationTodayCount(data, repository, date, kind, baseView, timing) {
    const sameDayView = isLatestCommentView(baseView, date) ? baseView : null
    if (kind !== 'create' && sameDayView) return Number(sameDayView.todayCount)

    if (kind === 'create') {
        const daily = await measure(timing, 'todayCount', () =>
            repository.getDailyCount(date).catch(() => null))
        const knownCounts = [
            sameDayView ? Number(sameDayView.todayCount) : null,
            isDailyCommentCount(daily, date) ? Number(daily.count) : null,
        ].filter(value => value !== null)
        if (knownCounts.length > 0) return Math.max(...knownCounts) + 1
    }

    return resolvePublishedCount(data, date, {
        timing,
        views: sameDayView ? [sameDayView] : [],
    })
}

async function persistDailyCount(repository, date, count) {
    await repository.setDailyCount(date, {
        version: DAILY_COMMENT_COUNT_VERSION,
        date,
        count,
        updatedAt: Date.now(),
    })
}

export async function mutateCommentViewsAndRefresh(
    data,
    date,
    mutation,
    timing = null,
    options = {},
) {
    return withLatestViewLock(data, async () => {
        const repository = createCommentRepository(data)
        const current = await measure(timing, 'latestView', () =>
            repository.getLatest(false).catch(() => null))
        const previous = isLatestCommentView(current)
            ? null
            : await measure(timing, 'previousView', () =>
                repository.getPreviousLatest(false).catch(() => null))
        let baseView = isLatestCommentView(current)
            ? current
            : isLatestCommentView(previous) ? previous : null
        let todayCount
        let guard = null

        if (Number.isSafeInteger(options.excludeCommentId)) {
            todayCount = await mutationTodayCount(
                data,
                repository,
                date,
                options.kind,
                baseView,
                timing,
            )
            if (!baseView) baseView = await buildLatestCommentView(data, date, timing, todayCount)
            const guardRevision = await allocateSnapshotRevision(
                repository,
                current,
                previous,
                baseView,
            )
            guard = guardLatestView(
                baseView,
                date,
                todayCount,
                options.excludeCommentId,
                guardRevision,
            )
            await repository.setPreviousLatest(guard)
            await repository.setLatest(guard)
        }

        try {
            await mutation()
        } catch (error) {
            if (error && typeof error === 'object') error.commentViewStage = 'views'
            throw error
        }
        let view
        try {
            todayCount ??= await mutationTodayCount(
                data,
                repository,
                date,
                options.kind,
                baseView,
                timing,
            )
            if (options.kind === 'create') {
                await persistDailyCount(repository, date, todayCount)
            }
            const snapshotRevision = await allocateSnapshotRevision(
                repository,
                current,
                previous,
                baseView,
                guard,
            )
            view = options.kind === 'like' && baseView && options.comment
                ? patchLatestView(
                    baseView,
                    date,
                    todayCount,
                    options.comment,
                    snapshotRevision,
                )
                : await buildLatestCommentView(
                    data,
                    date,
                    timing,
                    todayCount,
                    snapshotRevision,
                )
            if (!guard && baseView) await repository.setPreviousLatest(baseView)
            await repository.setLatest(view)
        } catch (error) {
            if (error && typeof error === 'object') error.commentViewStage = 'latest'
            throw error
        }
        return view
    }, timing)
}

export async function refreshLatestCommentView(data, date, timing = null) {
    return mutateCommentViewsAndRefresh(data, date, () => {}, timing, { kind: 'rebuild' })
}
