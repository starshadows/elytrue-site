import { createHash, randomUUID } from 'node:crypto'
import { httpError } from './http.js'
import { blobKeys } from './domain/blob-keys.js'
import { mapWithConcurrency } from './lib/concurrency.js'
import { createCommentRepository } from './repositories/comment-repository.js'
import { preserveCommentNumberBeforeDelete } from './services/report-service.js'
import {
    COMMENT_READ_CONCURRENCY,
    LATEST_COMMENT_COUNT,
    LATEST_COMMENT_SCAN_LIMIT,
    hideCommentViews,
    isCommentCard,
    isLatestCommentView,
    listHiddenViewKeys,
    listPublicViewKeys,
    loadPublicCards,
    markCommentViewRepair,
    mutateCommentViewsAndRefresh,
    publicViewId,
    replyPreview,
    resolvePublishedCount,
    toCommentCard,
    userViewId,
    writeCommentViews,
} from './services/comment-view-service.js'
import { getJSON, isPreconditionFailure } from './storage.js'
import { sanitizePlainText, validateComment } from '../shared/validation.js'

const INTERNAL_ID_THRESHOLD = 1e12
const likeMutationQueues = new Map()

function measure(timing, category, operation) {
    return timing?.measure(category, operation) ?? operation()
}

export function newCommentId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

export function shanghaiDateString(ms) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms))
}

function isVisibleFor(comment, viewer) {
    return !comment.hidden || viewer?.role === 'admin' || viewer?.id === comment.uid
}

export async function resolveCommentId(data, value) {
    const raw = Number(value)
    if (!Number.isSafeInteger(raw) || raw <= 0) return null
    if (raw >= INTERNAL_ID_THRESHOLD) {
        return await getJSON(data, blobKeys.comment(raw)) ? raw : null
    }
    const seat = await getJSON(data, blobKeys.commentNumber(raw))
    return seat?.commentId && !seat.tombstone ? Number(seat.commentId) : null
}

const VISIBILITY_CARD_FIELDS = [
    'id', 'number', 'displayId', 'uid', 'sender', 'avatar', 'comment', 'image',
    'replyid', 'createdAt', 'time', 'hidden', 'likes',
]

function publicViewMatchesCanonical(view, canonical) {
    if (!isCommentCard(view) || view.hidden) return false
    const expected = toCommentCard(canonical)
    return VISIBILITY_CARD_FIELDS.every(field => Object.is(view[field], expected[field]))
        && JSON.stringify(view.replyPreview ?? null)
            === JSON.stringify(expected.replyPreview ?? null)
}

function isCanonicalVisibilityComment(value, id) {
    return Boolean(
        value
        && value.id === id
        && isCommentCard(value)
        && typeof value.sender === 'string'
        && typeof value.avatar === 'string'
        && typeof value.image === 'string'
        && typeof value.hidden === 'boolean'
        && Number.isFinite(value.createdAt)
        && Number.isFinite(value.likes)
        && Number.isSafeInteger(value.version)
        && value.version > 0
        && (value.deleting === undefined || typeof value.deleting === 'boolean'),
    )
}

export async function getCommentVisibility(data, ids) {
    const repository = createCommentRepository(data)
    return mapWithConcurrency(ids, async id => {
        let canonical
        try {
            canonical = await repository.get(id)
        } catch {
            return { id, state: 'indeterminate' }
        }
        if (canonical === null) return { id, state: 'not_visible' }
        if (!isCanonicalVisibilityComment(canonical, id)) {
            return { id, state: 'indeterminate' }
        }
        if (canonical.hidden === true || canonical.deleting === true) {
            return { id, state: 'not_visible' }
        }
        let publicView
        try {
            publicView = await repository.getPublicView(id)
        } catch {
            return { id, state: 'indeterminate' }
        }
        return {
            id,
            state: publicViewMatchesCanonical(publicView, canonical)
                ? 'visible'
                : 'indeterminate',
        }
    }, COMMENT_READ_CONCURRENCY)
}

async function claimCommentNumber(data, commentId, reservationId) {
    const repository = createCommentRepository(data)
    const hint = Number((await repository.getNumberHint())?.value || 0)
    let number = hint + 1
    for (let attempt = 0; attempt < 2000; attempt += 1) {
        try {
            await repository.setNumber(number, {
                commentId,
                reservationId,
                createdAt: Date.now(),
            }, { onlyIfNew: true })
            await repository.setNumberHint({ value: number, updatedAt: Date.now() }).catch(() => {})
            return number
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            number += 1
        }
    }
    throw httpError(500, '留言编号分配失败，请稍后再试')
}

async function rollbackCreate(data, comment, reservationId, aliases) {
    const repository = createCommentRepository(data)
    const failures = []
    if (comment?.number) {
        const seat = await repository.getNumber(comment.number).catch(() => null)
        if (seat?.reservationId === reservationId) {
            await repository.deleteNumber(comment.number)
                .catch(error => failures.push(`number:${error?.message || error}`))
        }
    }
    if (comment?.id) {
        const cleanup = await Promise.allSettled([
            repository.delete(comment.id),
            repository.deletePublicView(comment.id),
            repository.deleteHiddenView(comment.id),
            ...(comment.uid
                ? [repository.deleteUserView(comment.uid, comment.id)]
                : []),
        ])
        cleanup.forEach((result, index) => {
            if (result.status === 'rejected') {
                failures.push(`resource-${index}:${result.reason?.message || result.reason}`)
            }
        })
    }
    for (const { imageId, alias, activated } of aliases) {
        if (!activated) continue
        await data.setJSON(blobKeys.imageAlias('comments', imageId), {
            ...alias,
            status: 'pending',
        }).catch(error => failures.push(`image:${error?.message || error}`))
    }
    if (failures.length > 0) {
        console.error(JSON.stringify({
            event: 'comment_create_rollback_failed',
            commentId: comment?.id,
            failures,
        }))
    }
}

async function claimCreateOperation(data, operationId, body) {
    if (!operationId) return null
    const key = blobKeys.commentOperation(operationId)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const existing = await getJSON(data, key)
    if (existing?.requestHash && existing.requestHash !== requestHash) {
        throw httpError(409, '幂等键已用于其他留言')
    }
    if (existing?.status === 'completed' && isCommentCard(existing.result)) return existing.result
    if (existing?.status === 'materialized' && isCommentCard(existing.result)) {
        await data.setJSON(key, {
            ...existing,
            status: 'completed',
            completedAt: Date.now(),
        })
        return existing.result
    }
    if (existing?.status === 'rolled-back') throw httpError(500, '留言发布失败，请使用新的幂等键重试')
    if (existing) throw httpError(409, '留言正在发布，请稍后重试')
    try {
        await data.setJSON(key, {
            type: 'comment-create',
            status: 'claimed',
            requestHash,
            createdAt: Date.now(),
        }, { onlyIfNew: true })
    } catch (error) {
        if (!isPreconditionFailure(error)) throw error
        const winner = await getJSON(data, key)
        if (winner?.requestHash && winner.requestHash !== requestHash) {
            throw httpError(409, '幂等键已用于其他留言')
        }
        if (winner?.status === 'completed' && isCommentCard(winner.result)) return winner.result
        throw httpError(409, '留言正在发布，请稍后重试')
    }
    return null
}

async function writeOperation(data, operationId, value) {
    if (!operationId) return
    const key = blobKeys.commentOperation(operationId)
    const existing = await getJSON(data, key)
    await data.setJSON(key, { ...existing, ...value })
}

/**
 * Reply previews use publish-time snapshot semantics. Later hiding or deleting
 * the target does not rewrite replies and does not add reads to list requests.
 */
export async function createComment(data, user, body, options = {}) {
    const { idFactory = newCommentId, timing, operationId = null } = options
    const commentError = validateComment(body.comment)
    if (commentError) throw httpError(400, commentError)
    const rawImageIds = Array.isArray(body.imageKeys) ? body.imageKeys.map(String) : []
    if (rawImageIds.length > 3) throw httpError(400, '每条留言最多上传 3 张图片')
    const imageIds = [...new Set(rawImageIds)]
    if (!user && imageIds.length > 0) throw httpError(401, '匿名留言不能上传图片')
    const aliases = await mapWithConcurrency(imageIds, async imageId => {
        const alias = await getJSON(data, blobKeys.imageAlias('comments', imageId))
        if (!alias || alias.userId !== user?.id) throw httpError(400, '留言图片无效')
        return { imageId, alias, activated: false }
    }, COMMENT_READ_CONCURRENCY)

    let replyid = null
    let replySnapshot
    if (body.replyid !== undefined && body.replyid !== null && body.replyid !== '') {
        replyid = await resolveCommentId(data, body.replyid)
        const target = replyid ? await getJSON(data, blobKeys.comment(replyid)) : null
        if (!target || !isVisibleFor(target, user)) throw httpError(404, '回复的留言不存在')
        replySnapshot = replyPreview(target, replyid)
    }

    const claimedResult = await claimCreateOperation(data, operationId, body)
    if (claimedResult) return claimedResult

    const repository = createCommentRepository(data)
    const reservationId = randomUUID()
    const createdAt = Date.now()
    const date = shanghaiDateString(createdAt)
    let comment = null
    for (let attempt = 0; attempt < 5 && !comment; attempt += 1) {
        const id = idFactory()
        const candidate = {
            id,
            number: 0,
            uid: user?.id ?? null,
            sender: user?.name ?? '匿名用户',
            avatar: user?.avatarKey || '',
            comment: sanitizePlainText(body.comment),
            image: imageIds.join(','),
            replyid,
            hidden: false,
            likes: 0,
            version: 1,
            createdAt,
            time: Math.floor(createdAt / 1000),
            ...(replySnapshot ? { replyPreview: replySnapshot } : {}),
        }
        try {
            await repository.set(id, candidate, { onlyIfNew: true })
            comment = candidate
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
        }
    }
    if (!comment) throw httpError(500, '留言创建失败，请稍后再试')

    try {
        await writeOperation(data, operationId, {
            type: 'comment-create',
            status: 'publishing',
            commentId: comment.id,
            createdAt,
        })
    } catch (error) {
        await repository.delete(comment.id).catch(() => {})
        if (operationId) await data.delete(blobKeys.commentOperation(operationId)).catch(() => {})
        throw httpError(500, '留言创建失败，请稍后再试')
    }

    try {
        comment.number = await measure(timing, 'index', () =>
            claimCommentNumber(data, comment.id, reservationId))
        await repository.set(comment.id, comment)
        for (const aliasRecord of aliases) {
            if (aliasRecord.alias.status === 'active') continue
            await data.setJSON(blobKeys.imageAlias('comments', aliasRecord.imageId), {
                ...aliasRecord.alias,
                status: 'active',
            })
            aliasRecord.activated = true
        }
    } catch (error) {
        await rollbackCreate(data, comment, reservationId, aliases)
        await writeOperation(data, operationId, {
            type: 'comment-create',
            status: 'rolled-back',
            commentId: comment.id,
            updatedAt: Date.now(),
        }).catch(() => {})
        throw error?.status ? error : httpError(500, '留言创建失败，请稍后再试')
    }

    let readModelFailure = null
    let visibleSinceRevision = null
    try {
        const latestView = await mutateCommentViewsAndRefresh(
            data,
            date,
            async () => {
                await repository.setDateFact(date, comment.id, { commentId: comment.id, createdAt })
                return writeCommentViews(data, comment)
            },
            timing,
            { kind: 'create', comment },
        )
        if (Number.isSafeInteger(latestView?.snapshotRevision)) {
            visibleSinceRevision = latestView.snapshotRevision
        }
    } catch (error) {
        readModelFailure = error
        await markCommentViewRepair(
            data,
            comment.id,
            error?.commentViewStage === 'latest' ? 'latest-view' : 'create-read-model',
            error,
            { date },
        )
    }

    const result = {
        ...toCommentCard(comment),
        ...(visibleSinceRevision === null ? {} : { visibleSinceRevision }),
    }
    try {
        await writeOperation(data, operationId, {
            type: 'comment-create',
            status: 'materialized',
            commentId: comment.id,
            materializedAt: Date.now(),
            result,
            ...(readModelFailure ? { repairPending: true } : {}),
        })
        await writeOperation(data, operationId, {
            type: 'comment-create',
            status: 'completed',
            commentId: comment.id,
            completedAt: Date.now(),
            result,
        })
    } catch (error) {
        await markCommentViewRepair(data, comment.id, 'operation-record', error)
        throw httpError(500, '留言已发布，请使用相同幂等键重试')
    }
    return result
}

async function attachViewerLikes(data, items, viewer, timing) {
    if (!viewer || items.length === 0) return items
    const states = await getViewerLikeStates(data, items.map(item => item.id), viewer, timing)
    const liked = new Map(states.map(state => [state.id, state.liked]))
    return items.map(item => ({ ...item, liked: liked.get(item.id) === true }))
}

async function listUserComments(data, query, viewer, uid, timing) {
    const count = Math.min(100, Math.max(1, Number(query.get('count') || 20)))
    const offset = Math.max(0, Number(query.get('from') || 0))
    const cursorValue = query.get('cursor')
    const cursor = cursorValue ? Number(cursorValue) : 0
    if (cursorValue && (!Number.isSafeInteger(cursor) || cursor <= 0)) {
        throw httpError(400, '留言游标无效')
    }
    const response = await measure(timing, 'index', () => data.list({
        prefix: blobKeys.commentsByUserPrefix(uid),
        limit: Infinity,
        consistency: 'strong',
    }))
    const ids = (response?.blobs || [])
        .map(blob => ({ blob, id: userViewId(blob.key) }))
        .filter(entry => entry.id && (!cursor || entry.id < cursor))
        .slice(offset)
    const selected = ids.slice(0, count)
    const values = await measure(timing, 'commentBodies', () => mapWithConcurrency(
        selected,
        entry => getJSON(data, entry.blob.key),
        COMMENT_READ_CONCURRENCY,
    ))
    const items = values
        .filter(isCommentCard)
        .filter(comment => isVisibleFor(comment, viewer))
    return {
        items,
        hasMore: ids.length > selected.length,
        nextCursor: ids.length > selected.length && selected.length > 0
            ? selected.at(-1).id
            : null,
    }
}

async function directComment(data, commentId, viewer, timing) {
    const comment = await measure(timing, 'commentBodies', () =>
        getJSON(data, blobKeys.comment(commentId)))
    if (!comment || !isVisibleFor(comment, viewer)) return []
    return attachViewerLikes(data, [toCommentCard(comment)], viewer, timing)
}

function pageFromLatest(view, count) {
    const items = view.items.slice(0, count)
    const hasMore = view.items.length > count || Boolean(view.hasMore)
    return {
        items,
        hasMore,
        ...(hasMore && items.length > 0 ? { nextCursor: items.at(-1).id } : {}),
        todayCount: view.todayCount,
        snapshotGeneratedAt: view.generatedAt,
        ...(Number.isSafeInteger(view.snapshotRevision)
            ? { snapshotRevision: view.snapshotRevision }
            : {}),
    }
}

function selectPublicEntries(entries, { count, cursor, direction, from, rawCount, beforeTime }) {
    let candidates = entries
    let takeFromEnd = false
    if (cursor) {
        if (direction === 'after') {
            candidates = entries.filter(entry => entry.id > cursor)
            takeFromEnd = true
        } else {
            candidates = entries.filter(entry => entry.id < cursor)
        }
    } else if (from) {
        if (rawCount < 0) {
            candidates = entries.filter(entry => entry.id > from)
            takeFromEnd = true
        } else {
            candidates = entries.filter(entry => entry.id < from)
        }
    } else if (beforeTime) {
        const boundaryMs = beforeTime * 1000 + (Number.isInteger(beforeTime) ? 999 : 0)
        const upperId = Math.floor(boundaryMs) * 1000 + 999
        candidates = entries.filter(entry => entry.id <= upperId)
    }
    return {
        selected: takeFromEnd ? candidates.slice(-count) : candidates.slice(0, count),
        hasMore: candidates.length > count,
        takeFromEnd,
    }
}

export async function listComments(data, query, viewer, options = {}) {
    const {
        timing,
        publicRead = false,
        preferLatest = false,
        includeTodayCount = false,
    } = options
    const uid = query.get('uid')
    if (uid) return listUserComments(data, query, viewer, uid, timing)

    const requestedCount = Number(query.get('count') || 30)
    const count = Math.min(100, Math.max(1, Math.abs(requestedCount)))
    const cursorRaw = query.get('cursor')
    const cursor = cursorRaw ? Number(cursorRaw) : 0
    const direction = query.get('direction')
    if (cursorRaw && (!Number.isSafeInteger(cursor) || cursor <= 0)) {
        throw httpError(400, '留言游标无效')
    }
    if (cursorRaw && !['after', 'before'].includes(direction)) {
        throw httpError(400, '留言游标方向无效')
    }
    const from = Number(query.get('from') || 0)
    const beforeTime = Number(query.get('time') || 0)

    const numberParam = query.get('number')
    if (numberParam) {
        const seat = await measure(timing, 'index', () =>
            getJSON(data, blobKeys.commentNumber(Number(numberParam))))
        if (!seat?.commentId || seat.tombstone) throw httpError(404, '留言不存在')
        const items = await directComment(data, Number(seat.commentId), viewer, timing)
        if (items.length === 0) return []
        return items
    }

    if (from && requestedCount === 1 && !cursorRaw) {
        const id = await resolveCommentId(data, from)
        return id ? directComment(data, id, viewer, timing) : []
    }

    const initial = !cursorRaw && !from && !beforeTime
    if ((publicRead || preferLatest) && initial && count <= LATEST_COMMENT_COUNT) {
        const repository = createCommentRepository(data)
        const latest = await measure(timing, 'latestView', () =>
            repository.getLatest(publicRead).catch(() => null))
        const previous = isLatestCommentView(latest)
            ? null
            : await measure(timing, 'previousView', () =>
                repository.getPreviousLatest(publicRead).catch(() => null))
        const snapshot = isLatestCommentView(latest)
            ? latest
            : isLatestCommentView(previous) ? previous : null
        if (snapshot) {
            const snapshotPage = pageFromLatest(snapshot, count)
            const page = viewer
                ? {
                    ...snapshotPage,
                    items: await attachViewerLikes(data, snapshotPage.items, viewer, timing),
                }
                : snapshotPage
            const today = shanghaiDateString(Date.now())
            if (includeTodayCount && snapshot.date !== today) {
                try {
                    return {
                        ...page,
                        todayCount: await resolvePublishedCount(data, today, {
                            publicRead,
                            timing,
                            views: [latest, previous],
                        }),
                    }
                } catch (error) {
                    return { ...page, todayCount: null, todayCountError: error }
                }
            }
            return page
        }
    }

    // Once the latest snapshot is unavailable, the public view and the date
    // facts are independent Blob lists. Bootstrap opts into reading them in
    // parallel; ordinary comment-list responses keep their existing shape.
    /** @type {Promise<PromiseSettledResult<number>> | null} */
    const todayCountRequest = includeTodayCount && initial
        ? resolvePublishedCount(data, shanghaiDateString(Date.now()), {
            publicRead,
            timing,
        }).then(
            value => ({ status: 'fulfilled', value }),
            reason => ({ status: 'rejected', reason }),
        )
        : null

    const boundedInitial = (publicRead || preferLatest)
        && initial
        && count <= LATEST_COMMENT_COUNT
    const blobs = await measure(timing, 'readView', async () => {
        const publicBlobs = await listPublicViewKeys(data, {
            publicRead,
            ...(boundedInitial
                ? { limit: LATEST_COMMENT_SCAN_LIMIT, paginate: false }
                : {}),
        })
        if (viewer?.role !== 'admin') return publicBlobs
        return [...publicBlobs, ...await listHiddenViewKeys(data)]
            .sort((left, right) => String(left.key).localeCompare(String(right.key)))
    })
    const entriesById = new Map()
    for (const blob of blobs) {
        const id = publicViewId(blob.key)
        if (!id || (entriesById.has(id) && !String(blob.key).includes('/public/'))) continue
        entriesById.set(id, { blob, id })
    }
    const entries = [...entriesById.values()]
        .sort((left, right) => right.id - left.id)
    const page = selectPublicEntries(entries, {
        count,
        cursor,
        direction,
        from,
        rawCount: requestedCount,
        beforeTime,
    })
    const candidates = boundedInitial ? entries : page.selected
    const loadedItems = await loadPublicCards(data, candidates.map(entry => entry.blob), {
        publicRead,
        includeHidden: viewer?.role === 'admin',
        timing,
    })
    const items = boundedInitial ? loadedItems.slice(0, count) : loadedItems
    const hasMore = boundedInitial
        ? entries.length >= LATEST_COMMENT_SCAN_LIMIT || loadedItems.length > count
        : page.hasMore
    const todayCountResult = todayCountRequest
        ? await todayCountRequest
        : null
    return {
        items: await attachViewerLikes(data, items, viewer, timing),
        hasMore,
        ...(hasMore && items.length > 0
            ? { nextCursor: page.takeFromEnd ? items[0].id : items.at(-1).id }
            : {}),
        ...(todayCountResult
            ? {
                todayCount: todayCountResult.status === 'fulfilled'
                    ? todayCountResult.value
                    : null,
                ...(todayCountResult.status === 'rejected'
                    ? { todayCountError: todayCountResult.reason }
                    : {}),
            }
            : {}),
    }
}

function isValidCalendarDate(year, month, day) {
    const probe = new Date(Date.UTC(year, month - 1, day))
    return probe.getUTCFullYear() === year
        && probe.getUTCMonth() === month - 1
        && probe.getUTCDate() === day
}

export async function countComments(data, query, options = {}) {
    const date = query.get('date') || shanghaiDateString(Date.now())
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
    if (!match) throw httpError(400, '日期格式不正确')
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (!isValidCalendarDate(year, month, day)) throw httpError(400, '日期格式不正确')
    return resolvePublishedCount(data, date, {
        publicRead: Boolean(options.publicRead),
    })
}

export async function getViewerLikeStates(data, ids, user, timing = null) {
    return mapWithConcurrency(ids, async id => ({
        id,
        liked: Boolean(await measure(timing, 'likes', () =>
            getJSON(data, blobKeys.commentLike(id, user.id)))),
    }), COMMENT_READ_CONCURRENCY)
}

export async function countLikeRecords(data, commentId) {
    let count = 0
    let cursor
    do {
        const page = await data.list({
            prefix: blobKeys.commentLikePrefix(commentId),
            limit: 500,
            paginate: false,
            ...(cursor ? { cursor } : {}),
            consistency: 'strong',
        })
        const blobs = page?.blobs || []
        count += blobs.length
        const nextCursor = page?.cursor
        if (!nextCursor || nextCursor === cursor || blobs.length < 500) break
        cursor = nextCursor
    } while (true)
    return count
}

async function claimCommentMutation(data, commentId, type) {
    const repository = createCommentRepository(data)
    const owner = randomUUID()
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const comment = await repository.get(commentId)
        if (!comment) return null
        const version = Math.max(1, Number(comment.version) || 1)
        if (version > 1) {
            const previousClaim = await repository.getMutationClaim(commentId, version)
            if (previousClaim && previousClaim.status !== 'completed') {
                if (attempt < 19) {
                    await new Promise(resolve => setTimeout(resolve, 5))
                    continue
                }
                await markCommentViewRepair(data, commentId, 'mutation-claim', new Error('previous mutation is incomplete'), {
                    mutationType: type,
                    blockedVersion: version,
                })
                throw httpError(500, '留言状态更新中，请稍后重试')
            }
        }
        const nextVersion = version + 1
        try {
            await repository.claimMutation(commentId, nextVersion, {
                commentId,
                version: nextVersion,
                owner,
                type,
                status: 'pending',
                createdAt: Date.now(),
            })
            return { comment, nextVersion, owner }
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            const latest = await repository.get(commentId)
            if (!latest) return null
            if (Number(latest.version || 1) >= nextVersion) continue
            if (attempt < 19) {
                await new Promise(resolve => setTimeout(resolve, 5))
                continue
            }
            await markCommentViewRepair(data, commentId, 'mutation-claim', error, {
                mutationType: type,
                blockedVersion: nextVersion,
            })
            throw httpError(500, '留言状态更新中，请稍后重试')
        }
    }
    throw httpError(409, '留言状态已变化，请重试')
}

async function completeCommentMutation(data, commentId, claim) {
    const repository = createCommentRepository(data)
    const current = await repository.getMutationClaim(commentId, claim.nextVersion).catch(() => null)
    if (current?.owner === claim.owner) {
        await repository.setMutationClaim(commentId, claim.nextVersion, {
            ...current,
            status: 'completed',
            completedAt: Date.now(),
        })
    }
}

async function releaseCommentMutation(data, commentId, claim) {
    if (!claim) return
    const repository = createCommentRepository(data)
    const current = await repository.getMutationClaim(commentId, claim.nextVersion).catch(() => null)
    if (current?.owner === claim.owner) {
        await repository.deleteMutationClaim(commentId, claim.nextVersion).catch(() => {})
    }
}

export async function setLike(data, commentId, user, liked, options = {}) {
    const { timing } = options
    const previous = likeMutationQueues.get(commentId) || Promise.resolve()
    const mutation = previous.then(async () => {
        const repository = createCommentRepository(data)
        const claim = await measure(timing, 'commentBodies', () =>
            claimCommentMutation(data, commentId, liked ? 'like' : 'unlike'))
        const comment = claim?.comment
        if (!claim || !comment || comment.hidden || comment.deleting) {
            await releaseCommentMutation(data, commentId, claim)
            throw httpError(404, '留言不存在')
        }
        const factKey = blobKeys.commentLike(commentId, user.id)
        let canonicalCommitted = false
        try {
            await measure(timing, 'likes', async () => {
                if (liked) {
                    await data.setJSON(factKey, {
                        userId: user.id,
                        createdAt: Date.now(),
                    }, { onlyIfNew: true }).catch(error => {
                        if (!isPreconditionFailure(error)) throw error
                    })
                } else {
                    await data.delete(factKey)
                }
            })
            const likes = await measure(timing, 'likes', () => countLikeRecords(data, commentId))
            comment.likes = likes
            comment.version = claim.nextVersion
            comment.updatedAt = Date.now()
            await repository.set(commentId, comment)
            canonicalCommitted = true
            try {
                await mutateCommentViewsAndRefresh(
                    data,
                    shanghaiDateString(Date.now()),
                    () => writeCommentViews(data, comment),
                    timing,
                    { kind: 'like', comment },
                )
            } catch (error) {
                await markCommentViewRepair(data, commentId, 'like', error, {
                    authoritativeLikes: likes,
                })
            }
            await completeCommentMutation(data, commentId, claim)
            return { liked: Boolean(liked), likes }
        } catch (error) {
            if (!canonicalCommitted) {
                const authoritativeLikes = await countLikeRecords(data, commentId).catch(() => null)
                await markCommentViewRepair(data, commentId, 'like-canonical', error, {
                    authoritativeLikes,
                })
                await releaseCommentMutation(data, commentId, claim)
            }
            throw error
        }
    })
    const queued = mutation.then(() => {}, () => {})
    likeMutationQueues.set(commentId, queued)
    try {
        return await mutation
    } finally {
        if (likeMutationQueues.get(commentId) === queued) likeMutationQueues.delete(commentId)
    }
}

export async function moderateComment(data, commentId, action) {
    if (!['delete', 'hide', 'restore'].includes(action)) {
        throw httpError(400, '管理操作无效')
    }
    const repository = createCommentRepository(data)
    const claim = await claimCommentMutation(data, commentId, `moderate-${action}`)
    const comment = claim?.comment
    if (!claim || !comment) {
        if (action === 'delete') {
            const marker = await getJSON(data, blobKeys.commentViewRepair(commentId))
            if (marker?.deleted) {
                await mutateCommentViewsAndRefresh(
                    data,
                    shanghaiDateString(Date.now()),
                    async () => {
                        await repository.deletePublicView(commentId)
                        await repository.deleteHiddenView(commentId)
                        if (marker.uid) await repository.deleteUserView(marker.uid, commentId)
                    },
                    null,
                    { kind: 'delete', excludeCommentId: commentId },
                )
            }
            return
        }
        throw httpError(404, '留言不存在')
    }
    const date = shanghaiDateString(Date.now())
    const original = structuredClone(comment)
    comment.hidden = action !== 'restore'
    comment.deleting = action === 'delete'
    comment.version = claim.nextVersion
    comment.updatedAt = Date.now()
    let canonicalCommitted = false
    try {
        await mutateCommentViewsAndRefresh(data, date, async () => {
            if (action === 'hide' || action === 'delete') {
                await hideCommentViews(data, comment)
            }
            try {
                await repository.set(comment.id, comment)
                canonicalCommitted = true
            } catch (error) {
                if (action !== 'restore') await writeCommentViews(data, original).catch(() => {})
                throw error
            }
            if (action === 'restore') await writeCommentViews(data, comment)
            if (action !== 'delete') return

            await preserveCommentNumberBeforeDelete(data, comment)
            const seat = await repository.getNumber(comment.number)
            if (seat) {
                await repository.setNumber(comment.number, {
                    ...seat,
                    commentId: comment.id,
                    number: comment.number,
                    tombstone: true,
                    deletedAt: Date.now(),
                })
            }
            await repository.delete(comment.id)
            if (comment.uid) {
                await repository.deleteUserView(comment.uid, comment.id)
            }
            await repository.deleteHiddenView(comment.id)
        }, null, {
            kind: action,
            comment,
            ...(action === 'hide' || action === 'delete'
                ? { excludeCommentId: commentId }
                : {}),
        })
        if (action !== 'delete') await completeCommentMutation(data, commentId, claim)
    } catch (error) {
        if (canonicalCommitted) await completeCommentMutation(data, commentId, claim)
        else await releaseCommentMutation(data, commentId, claim)
        await markCommentViewRepair(data, comment.id, action, error, {
            uid: comment.uid,
            number: comment.number,
            deleted: action === 'delete',
        })
        throw httpError(500, '管理操作失败，请稍后再试')
    }
}
