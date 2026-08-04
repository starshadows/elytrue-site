import { randomUUID } from 'node:crypto'
import { httpError } from './http.js'
import { getJSON, listAll, isPreconditionFailure } from './storage.js'
import { blobKeys, blobPrefixes } from './domain/blob-keys.js'
import { createReportRepository } from './repositories/report-repository.js'
import { preserveCommentNumberBeforeDelete } from './services/report-service.js'
import { mapWithConcurrency } from './lib/concurrency.js'
import { sanitizePlainText, validateComment } from '../shared/validation.js'
const INTERNAL_ID_THRESHOLD = 1e12
const READ_CONCURRENCY = 8
const DETAIL_CONCURRENCY = Math.max(1, Math.floor(READ_CONCURRENCY / 2))
const NUMBER_BATCH_SIZE = 48

function measure(timing, category, operation) {
    return timing?.measure(category, operation) ?? operation()
}

export function newCommentId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

/**
 * 把「公开编号或内部 ID」解析为内部 ID。
 * 公开编号(小数值)优先查编号索引;tombstone(硬删除空号)返回 null;
 * 旧数据未迁移时回退按内部 ID 直查。
 */
export async function resolveCommentId(data, value) {
    const raw = Number(value)
    if (!Number.isSafeInteger(raw) || raw <= 0) return null
    if (raw >= INTERNAL_ID_THRESHOLD) return raw
    const seat = await getJSON(data, blobKeys.commentNumber(raw))
    if (!seat || seat.tombstone) return null
    if (seat?.commentId) return Number(seat.commentId)
    const legacy = await getJSON(data, blobKeys.comment(raw))
    return legacy ? raw : null
}

/** 按 Asia/Shanghai 自然日返回 YYYY-MM-DD */
export function shanghaiDateString(ms) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms))
}

/** 原子认领下一个稳定公开编号(onlyIfNew 占位,并发安全,允许空洞) */
async function claimCommentNumber(data, commentId, reservationId) {
    const hint = Number((await getJSON(data, blobKeys.commentNumberHint))?.value || 0)
    let number = hint + 1
    for (let attempt = 0; attempt < 2000; attempt += 1) {
        try {
            await data.setJSON(blobKeys.commentNumber(number), {
                commentId,
                reservationId,
                createdAt: Date.now(),
            }, { onlyIfNew: true })
            await data
                .setJSON(blobKeys.commentNumberHint, { value: number, updatedAt: Date.now() })
                .catch(() => {})
            return number
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            number += 1
        }
    }
    throw httpError(500, '留言编号分配失败，请稍后再试')
}

/**
 * 回滚一次留言创建:删除正文、本次占用的编号(仅当 reservationId 匹配)、
 * 以及可能已写入的用户/日期索引。任何一步失败都记录结构化日志,不抛错。
 */
/**
 * @param {any} data
 * @param {number} commentId
 * @param {{reservationId: string, number?: number, uid: string, date: string}} resources
 */
async function rollbackCommentResources(data, commentId, { reservationId, number, uid, date }) {
    const failures = []
    if (number) {
        const seat = await getJSON(data, blobKeys.commentNumber(number)).catch(() => null)
        if (seat?.reservationId === reservationId) {
            await data
                .delete(blobKeys.commentNumber(number))
                .catch(error => failures.push(`seat:${error?.message || error}`))
        } else if (seat && seat.commentId !== commentId) {
            // 占位不属于本次操作:绝不删除,仅记录
            console.error(JSON.stringify({
                event: 'comment_rollback_seat_not_owned',
                commentId,
                number,
                seatCommentId: seat.commentId,
            }))
        }
    }
    await data
        .delete(blobKeys.comment(commentId))
        .catch(error => failures.push(`comment:${error?.message || error}`))
    if (uid) {
        const userIndexDeletes = [
            ['userIndex', blobKeys.commentByUser(uid, commentId)],
            ['userIndexV2', blobKeys.commentByUserV2(uid, commentId)],
        ]
        await Promise.all(userIndexDeletes.map(async ([label, key]) => {
            await data.delete(key).catch(error => failures.push(`${label}:${error?.message || error}`))
        }))
    }
    if (date) {
        await data
            .delete(blobKeys.commentByDate(date, commentId))
            .catch(error => failures.push(`dateIndex:${error?.message || error}`))
    }
    await createReportRepository(data)
        .deleteNumberReverse(commentId)
        .catch(error => failures.push(`numberReverse:${error?.message || error}`))
    if (failures.length > 0) {
        console.error(JSON.stringify({
            event: 'comment_rollback_failed',
            commentId,
            number,
            failures,
        }))
    }
}

/**
 * 创建留言。一致性约定:
 *   - 只有正文、公开编号、用户索引、日期索引全部写入成功才返回;
 *   - 任一步失败都回滚本操作已写入的资源(正文/编号占位/部分索引),
 *     保证不留指向不存在留言的编号占位;
 *   - 编号占位携带 reservationId,回滚只清理属于本次操作的占位。
 * @param {{idFactory?: () => number, timing?: import('./types.js').ServerTiming}} [options]
 */
export async function createComment(data, user, body, options = {}) {
    const { idFactory = newCommentId, timing } = options
    const commentError = validateComment(body.comment)
    if (commentError) throw httpError(400, commentError)
    const rawImageIds = Array.isArray(body.imageKeys) ? body.imageKeys.map(String) : []
    if (rawImageIds.length > 3) throw httpError(400, '每条留言最多上传 3 张图片')
    const imageIds = [...new Set(rawImageIds)]

    const aliases = []
    for (const imageId of imageIds) {
        const alias = await getJSON(data, blobKeys.imageAlias('comments', imageId))
        if (!alias || alias.userId !== user.id) throw httpError(400, '留言图片无效')
        aliases.push({ imageId, alias })
    }

    let replyid = null
    let replyTarget = null
    if (body.replyid !== undefined && body.replyid !== null && body.replyid !== '') {
        const targetId = await resolveCommentId(data, body.replyid)
        replyTarget = targetId ? await getJSON(data, blobKeys.comment(targetId)) : null
        if (!replyTarget) throw httpError(404, '回复的留言不存在')
        replyid = targetId
    }

    const reservationId = randomUUID()
    const createdAt = Date.now()
    const date = shanghaiDateString(createdAt)

    // 1. 写入正文(内部 ID 冲突则换号重试,最多 5 次;以 persisted 为准,不依赖对象真值)
    /** @type {null | {
     *   id: number,
     *   number?: number,
     *   uid: string,
     *   sender: string,
     *   avatar: string,
     *   comment: string,
     *   image: string,
     *   replyid: number | null,
     *   hidden: boolean,
     *   likeCount: number,
     *   likeCountVersion: number,
     *   createdAt: number,
     *   time: number,
     * }} */
    let comment = null
    let persisted = false
    for (let attempt = 0; attempt < 5 && !persisted; attempt += 1) {
        const id = idFactory()
        comment = {
            id,
            uid: user.id,
            sender: user.name,
            avatar: user.avatarKey || '',
            comment: sanitizePlainText(body.comment),
            image: imageIds.join(','),
            replyid,
            hidden: false,
            likeCount: 0,
            likeCountVersion: 1,
            createdAt,
            time: Math.floor(createdAt / 1000),
        }
        try {
            await data.setJSON(blobKeys.comment(id), comment, { onlyIfNew: true })
            persisted = true
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
        }
    }
    if (!persisted || !comment) {
        console.error(JSON.stringify({
            event: 'comment_persist_conflict',
            userId: user.id,
            attempts: 5,
        }))
        throw httpError(500, '留言创建失败，请稍后再试')
    }

    // 2. 认领公开编号,占位必须指向实际写入的内部 ID
    let number
    try {
        number = await measure(timing, 'index', () =>
            claimCommentNumber(data, comment.id, reservationId))
    } catch (error) {
        await rollbackCommentResources(data, comment.id, { reservationId, uid: user.id, date })
        console.error(JSON.stringify({
            event: 'comment_number_claim_failed',
            commentId: comment.id,
            error: String(error?.message || error).slice(0, 300),
        }))
        throw error
    }
    comment.number = number

    // 3. 回写编号 + 用户索引 + 日期索引;任一失败则回滚全部并返回 500
    try {
        const indexValue = { commentId: comment.id, createdAt }
        const writes = await measure(timing, 'index', () => Promise.allSettled([
            data.setJSON(blobKeys.comment(comment.id), comment),
            data.setJSON(blobKeys.commentByUser(user.id, comment.id), indexValue),
            data.setJSON(blobKeys.commentByUserV2(user.id, comment.id), indexValue),
            data.setJSON(blobKeys.commentByDate(date, comment.id), indexValue),
            createReportRepository(data).setNumberReverse(comment.id, number),
        ]))
        const failure = writes.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
    } catch (error) {
        await rollbackCommentResources(data, comment.id, { reservationId, number, uid: user.id, date })
        console.error(JSON.stringify({
            event: 'comment_index_write_failed',
            commentId: comment.id,
            number,
            error: String(error?.message || error).slice(0, 300),
        }))
        throw httpError(500, '留言创建失败，请稍后再试')
    }

    // 图片 pending→active 是留言成功条件:任一失败则回滚正文/编号/索引,
    // 并把本次已激活的图片还原为 pending,保证「被引用 ⇔ active」不变量
    const activated = []
    try {
        for (const { imageId, alias } of aliases) {
            if (alias.status !== 'active') {
                alias.status = 'active'
                await data.setJSON(blobKeys.imageAlias('comments', imageId), alias)
                activated.push({ imageId, alias })
            }
        }
    } catch (error) {
        await rollbackCommentResources(data, comment.id, { reservationId, number, uid: user.id, date })
        for (const { imageId, alias } of activated) {
            alias.status = 'pending'
            await data.setJSON(blobKeys.imageAlias('comments', imageId), alias).catch(rollbackError => {
                console.error(JSON.stringify({
                    event: 'comment_alias_revert_failed',
                    imageId,
                    error: String(rollbackError?.message || rollbackError).slice(0, 300),
                }))
            })
        }
        console.error(JSON.stringify({
            event: 'comment_alias_activation_failed',
            commentId: comment.id,
            number,
            error: String(error?.message || error).slice(0, 300),
        }))
        throw httpError(500, '留言创建失败，请稍后再试')
    }
    return {
        ...comment,
        displayId: comment.number ?? comment.id,
        likes: 0,
        liked: false,
        ...(replyid
            ? { replyPreview: replyPreview(isVisibleFor(replyTarget, user) ? replyTarget : null, replyid) }
            : {}),
    }
}

/** @param {number | null} [fallbackId] */
function replyPreview(comment, fallbackId = null) {
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
        displayId: comment.number ?? comment.id,
        sender: comment.sender || '',
        avatar: comment.avatar || '',
        comment: comment.comment || '',
    }
}

/** @typedef {{displayId: number, sender: string, avatar: string, comment: string, deleted?: boolean}} ReplyPreview */

/** @returns {Promise<Map<number, ReplyPreview>>} */
async function loadReplyPreviews(data, comments, viewer, timing) {
    const replyIds = [...new Set(
        comments
            .map(comment => Number(comment.replyid))
            .filter(id => Number.isSafeInteger(id) && id > 0),
    )]
    const previews = new Map()
    const replies = await measure(timing, 'replies', () => mapWithConcurrency(replyIds, id =>
        getJSON(data, blobKeys.comment(id)), READ_CONCURRENCY))
    replyIds.forEach((id, index) => {
        const comment = replies[index]
        previews.set(id, replyPreview(comment && isVisibleFor(comment, viewer) ? comment : null, id))
    })
    return previews
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

async function getCachedLikeCount(data, comment, timing) {
    const cacheKey = blobKeys.commentLikeCountCache(comment.id)
    const cached = await measure(timing, 'likes', () => getJSON(data, cacheKey))
    if (Number.isSafeInteger(cached?.count) && cached.count >= 0) return cached.count
    if (comment.likeCountVersion === 1) {
        return Math.max(0, Number(comment.likeCount) || 0)
    }

    const count = await measure(timing, 'likes', () => countLikeRecords(data, comment.id))
    await data.setJSON(cacheKey, {
        commentId: comment.id,
        count,
        updatedAt: Date.now(),
    }, { onlyIfNew: true }).catch(() => {})
    return count
}

/**
 * 读取单条留言,附加展示编号与点赞状态。
 * @param {Map<number, ReplyPreview> | null} [replyPreviews]
 * @param {import('./types.js').ServerTiming | null} [timing]
 */
export async function getCommentDetail(data, comment, viewer, replyPreviews = null, timing = null) {
    const [likes, likedRecord] = await Promise.all([
        getCachedLikeCount(data, comment, timing),
        viewer ? measure(timing, 'likes', () =>
            getJSON(data, blobKeys.commentLike(comment.id, viewer.id))) : null,
    ])
    const liked = Boolean(likedRecord)
    return {
        ...comment,
        displayId: comment.number ?? comment.id,
        likes,
        liked,
        ...(comment.replyid
            ? { replyPreview: replyPreviews?.get(comment.replyid) || await loadReplyPreviews(data, [comment], viewer, timing).then(map => map.get(comment.replyid)) }
            : {}),
    }
}

async function listAllCommentKeys(data) {
    const blobs = await listAll(data, blobPrefixes.comments, Infinity)
    return blobs.map(blob => blob.key)
}

/** @param {{lowerId?: number, upperId?: number, startNumber?: number | null, timing?: import('./types.js').ServerTiming}} [options] */
async function listRecentNumberedComments(data, count, scanCap, viewer, options = {}) {
    const { lowerId = 0, upperId = 0, startNumber = null, timing } = options
    const hint = Number(await measure(timing, 'index', async () =>
        (await getJSON(data, blobKeys.commentNumberHint))?.value || 0))
    const comments = []
    const ids = []
    let number = startNumber === null ? hint : Math.min(hint, startNumber)
    let scanned = 0
    let nextCursor = null

    while (number > 0 && scanned < scanCap && comments.length < count) {
        const batchSize = Math.min(NUMBER_BATCH_SIZE, number, scanCap - scanned)
        const numbers = Array.from({ length: batchSize }, (_, index) => number - index)
        const seats = await measure(timing, 'index', () => mapWithConcurrency(
            numbers,
            item => getJSON(data, blobKeys.commentNumber(item)),
            READ_CONCURRENCY,
        ))
        scanned += batchSize
        number -= batchSize

        const batchIds = seats
            .filter(seat => seat?.commentId && !seat.tombstone)
            .map(seat => Number(seat.commentId))
            .filter(id => (!lowerId || id > lowerId) && (!upperId || id < upperId))
        ids.push(...batchIds)
        const bodies = await measure(timing, 'comments', () => mapWithConcurrency(
            batchIds,
            id => getJSON(data, blobKeys.comment(id)),
            READ_CONCURRENCY,
        ))
        for (let index = 0; index < bodies.length; index += 1) {
            const comment = bodies[index]
            const consumedId = batchIds[index]
            if (consumedId) nextCursor = consumedId
            if (comment && isVisibleFor(comment, viewer)) comments.push(comment)
            if (comments.length >= count) {
                break
            }
        }
    }
    return {
        items: comments.sort((left, right) => right.id - left.id),
        ids,
        exhausted: number <= 0,
        truncated: comments.length < count && number > 0,
        nextCursor,
        hasNumberedData: hint > 0,
    }
}

function keyToId(key) {
    const match = String(key).match(/^comments\/(\d+)\.json$/u)
    return match ? Number(match[1]) : null
}

function isVisibleFor(comment, viewer) {
    return !comment.hidden || viewer?.role === 'admin' || viewer?.id === comment.uid
}

/**
 * 从升序 ids 中按可见留言数量收集,最多 count 条。
 * time 参数语义(Unix 秒):
 *   - 整数秒 T:包含该秒内全部 comment.time <= T 的留言(边界整秒含 ms 0..999);
 *   - 小数秒 T.5:按精确毫秒上界 createdAt <= T.5*1000 处理。
 * 返回 { items(可见留言,id 降序), truncated(是否因 scanCap 截断) }。
 */
async function collectVisibleComments(data, ids, {
    count,
    from,
    rawCount,
    beforeTime,
    viewer,
    centered,
    sourceTruncated = false,
    timing,
}) {
    let selected = []
    if (from && rawCount === 1) {
        const target = await resolveCommentId(data, from)
        selected = target ? [target] : []
    } else if (from && rawCount < 0) {
        selected = ids.filter(id => id > from).reverse()
    } else if (from) {
        if (centered && ids.includes(from)) {
            const index = ids.indexOf(from)
            selected = ids.slice(Math.max(0, index - Math.floor(count / 2)), index + Math.ceil(count / 2)).reverse()
        } else {
            selected = ids.filter(id => id < from).reverse()
        }
    } else if (beforeTime) {
        // id = createdAtMs*1000 + r(0 ≤ r < 1000);候选上界覆盖整秒(含 ms 999),
        // 精确边界由 createdAt 过滤决定
        const upperBound = beforeTime * 1_000_000 + 1_000_000
        selected = ids.filter(id => id <= upperBound).reverse()
    } else {
        selected = [...ids].reverse()
    }

    const isWholeSecond = Number.isInteger(beforeTime)
    const beforeTimeMs = beforeTime * 1000
    const boundaryMs = beforeTimeMs + (isWholeSecond ? 999 : 0)

    const comments = []
    const scanCap = Math.max(200, count * 20 + 200)
    let scanned = 0
    let nextCursor = null
    while (scanned < selected.length && scanned < scanCap && comments.length < count) {
        const batchIds = selected.slice(scanned, Math.min(selected.length, scanned + 32, scanCap))
        const bodies = await measure(timing, 'comments', () => mapWithConcurrency(
            batchIds,
            id => getJSON(data, blobKeys.comment(id)),
            READ_CONCURRENCY,
        ))
        scanned += batchIds.length
        for (let index = 0; index < bodies.length; index += 1) {
            const comment = bodies[index]
            nextCursor = batchIds[index] || nextCursor
            if (!comment) continue
            if (beforeTime) {
                // 有 createdAt 时按毫秒精确过滤;旧数据缺 createdAt 时回落 time 比较
                const createdAt = Number(comment.createdAt)
                if (Number.isFinite(createdAt) && createdAt > boundaryMs) continue
                if (!Number.isFinite(createdAt) && comment.time > beforeTime) continue
            }
            if (!isVisibleFor(comment, viewer)) continue
            comments.push(comment)
            if (comments.length >= count) break
        }
    }
    return {
        items: comments,
        truncated: comments.length < count && (sourceTruncated || selected.length > scanned),
        nextCursor,
    }
}

/** @param {{timing?: import('./types.js').ServerTiming}} [options] */
export async function listComments(data, query, viewer, options = {}) {
    const { timing } = options
    const uid = query.get('uid')
    if (uid) return listUserComments(data, query, viewer, uid, timing)

    const cursorParam = query.get('cursor')
    const cursorMode = cursorParam !== null
    const fromRaw = query.get('from')
    const from = cursorMode ? Number(cursorParam) : (fromRaw ? Number(fromRaw) : 0)
    const requestedCount = Number(query.get('count') || 30)
    const rawCount = cursorMode
        ? (query.get('direction') === 'after'
            ? -Math.abs(requestedCount)
            : Math.abs(requestedCount))
        : requestedCount
    if (cursorMode && (!Number.isSafeInteger(from) || from <= 0)) {
        throw httpError(400, '留言游标无效')
    }
    if (cursorMode && !['after', 'before'].includes(query.get('direction'))) {
        throw httpError(400, '留言游标方向无效')
    }
    const count = Math.min(100, Math.max(1, Math.abs(rawCount)))
    const beforeTime = Number(query.get('time') || 0)

    // 按公开编号跳转:number=N 返回该条留言(硬删除 tombstone 返回 404)
    const numberParam = query.get('number')
    if (numberParam) {
        const seat = await measure(timing, 'index', () =>
            getJSON(data, blobKeys.commentNumber(Number(numberParam))))
        if (!seat || seat.tombstone) throw httpError(404, '留言不存在')
        const comment = seat?.commentId
            ? await measure(timing, 'comments', () =>
                getJSON(data, blobKeys.comment(Number(seat.commentId))))
            : null
        if (!comment) throw httpError(404, '留言不存在')
        if (comment.hidden && viewer?.role !== 'admin' && viewer?.id !== comment.uid) {
            return []
        }
        return [await getCommentDetail(data, comment, viewer, null, timing)]
    }

    const scanCap = Math.max(200, count * 20 + 200)
    const directTarget = from && rawCount === 1 && !cursorMode
        ? await resolveCommentId(data, from)
        : null
    let cursorNumber = 0
    if (cursorMode && rawCount > 0) {
        const reverse = await measure(timing, 'index', () =>
            getJSON(data, blobKeys.commentNumberReverse(from)))
        cursorNumber = Number(reverse?.number) || 0
        if (!cursorNumber) {
            const cursorComment = await measure(timing, 'comments', () =>
                getJSON(data, blobKeys.comment(from)))
            cursorNumber = Number(cursorComment?.number) || 0
        }
    }
    const recent = !numberParam && !directTarget && (!from || cursorMode) && !beforeTime
        ? await listRecentNumberedComments(
            data,
            count,
            scanCap,
            viewer,
            {
                lowerId: cursorMode && rawCount < 0 ? from : 0,
                upperId: cursorMode && rawCount > 0 ? from : 0,
                startNumber: cursorNumber > 0 ? cursorNumber - 1 : null,
                timing,
            },
        )
        : null
    /** @type {number[]} */
    let ids = directTarget ? [directTarget] : (recent?.ids || []).sort((a, b) => a - b)
    let sourceTruncated = recent?.truncated || false
    let collected = recent
        ? {
            items: recent.items,
            truncated: recent.truncated,
            nextCursor: recent.nextCursor,
        }
        : null
    if (
        (!ids?.length && (!recent || !recent.hasNumberedData))
        || (recent && recent.exhausted && recent.items.length < count)
    ) {
        const keys = await measure(timing, 'index', () => listAllCommentKeys(data))
        ids = keys.map(keyToId).filter(id => id !== null)
        sourceTruncated = false
        collected = null
    }

    // 按可见留言数量收集(count=1 与居中窗口保持跳转语义)
    if (!collected) {
        collected = await collectVisibleComments(data, ids, {
            count,
            from,
            rawCount,
            beforeTime,
            viewer,
            centered: Boolean(!cursorMode && from && rawCount !== 1 && ids.includes(from)),
            sourceTruncated,
            timing,
        })
    }

    // 旧数据(未迁移)缺少 number 字段时,用 id 顺序作为展示编号
    const needFallback = collected.items.some(comment => !comment.number)
    const fallbackRanks = needFallback
        ? new Map(ids.map((id, index) => [id, index + 1]))
        : null

    const previews = await loadReplyPreviews(data, collected.items, viewer, timing)
    const items = await mapWithConcurrency(collected.items, comment => getCommentDetail(data, {
        ...comment,
        number: comment.number ?? fallbackRanks?.get(comment.id) ?? comment.id,
    }, viewer, previews, timing), DETAIL_CONCURRENCY)
    return {
        items,
        hasMore: collected.truncated,
        ...(collected.nextCursor ? { nextCursor: collected.nextCursor } : {}),
    }
}

function userV2Id(key) {
    const match = String(key).match(/-(\d{16})\.json$/u)
    return match ? Number(match[1]) : null
}

function encodeUserCursor(cursor, floor, phase = 'v2') {
    return `v2.${Buffer.from(JSON.stringify({ cursor, floor, phase })).toString('base64url')}`
}

function decodeUserCursor(value) {
    if (!String(value).startsWith('v2.')) return null
    try {
        const parsed = JSON.parse(Buffer.from(String(value).slice(3), 'base64url').toString())
        const cursorValid = parsed.cursor === null || typeof parsed.cursor === 'string'
        const phase = parsed.phase === 'legacy' ? 'legacy' : 'v2'
        return cursorValid && Number.isSafeInteger(Number(parsed.floor))
            ? { cursor: parsed.cursor, floor: Number(parsed.floor), phase }
            : null
    } catch {
        return null
    }
}

async function listLegacyUserComments(data, viewer, uid, {
    count,
    cursor = 0,
    offset = 0,
    upperId = 0,
    timing,
}) {
    const blobs = await measure(timing, 'index', () =>
        listAll(data, blobKeys.commentsByUserPrefix(uid), Infinity))
    const ids = blobs
        .map(blob => keyToId(blob.key.replace(/^indexes\/comments\/by-user\/[^/]+\//u, 'comments/')))
        .filter(id => id && (!cursor || id < cursor) && (!upperId || id < upperId))
        .sort((a, b) => b - a)
    const scanCap = Math.max(200, count * 20 + 200)
    const items = []
    let skipped = offset
    let scanned = 0

    while (scanned < ids.length && scanned < scanCap && items.length < count) {
        const batchSize = Math.min(32, Math.max(1, count - items.length + skipped))
        const batchIds = ids.slice(scanned, Math.min(ids.length, scanned + batchSize, scanCap))
        const bodies = await measure(timing, 'comments', () => mapWithConcurrency(
            batchIds,
            id => getJSON(data, blobKeys.comment(id)),
            READ_CONCURRENCY,
        ))
        scanned += batchIds.length
        for (const comment of bodies) {
            if (!comment || !isVisibleFor(comment, viewer)) continue
            if (skipped > 0) {
                skipped -= 1
                continue
            }
            items.push(comment)
            if (items.length >= count) break
        }
    }
    const hasMore = scanned < ids.length
    return {
        items,
        hasMore,
        nextCursor: hasMore && scanned > 0 ? ids[scanned - 1] : null,
    }
}

async function hasLegacyUserCommentsBefore(data, uid, floor, timing) {
    const page = await measure(timing, 'index', () => data.list({
        prefix: blobKeys.commentsByUserPrefix(uid),
        limit: 1,
        paginate: false,
        consistency: 'strong',
    }))
    const first = page?.blobs?.[0]
    if (!first) return false
    const id = keyToId(first.key.replace(/^indexes\/comments\/by-user\/[^/]+\//u, 'comments/'))
    return Boolean(id && id < floor)
}

async function listUserComments(data, query, viewer, uid, timing) {
    const offset = Math.max(0, Number(query.get('from') || 0))
    const cursorValue = query.get('cursor') || ''
    const count = Math.min(100, Math.max(1, Number(query.get('count') || 20)))
    const v2Cursor = decodeUserCursor(cursorValue)
    if (cursorValue && !v2Cursor) {
        const legacyCursor = Number(cursorValue)
        if (!Number.isSafeInteger(legacyCursor) || legacyCursor <= 0) {
            throw httpError(400, '留言游标无效')
        }
        return listLegacyUserComments(data, viewer, uid, {
            count,
            cursor: legacyCursor,
            offset,
            timing,
        })
    }
    if (v2Cursor?.phase === 'legacy') {
        return listLegacyUserComments(data, viewer, uid, {
            count,
            offset,
            upperId: v2Cursor.floor,
            timing,
        })
    }

    const items = []
    const scanCap = Math.max(200, count * 20 + 200)
    let scanned = 0
    let cursor = v2Cursor?.cursor || undefined
    let floor = v2Cursor?.floor || 0
    let skipped = offset
    let sawV2 = Boolean(v2Cursor)

    while (scanned < scanCap && items.length < count) {
        const page = await measure(timing, 'index', () => data.list({
            prefix: blobKeys.commentsByUserV2Prefix(uid),
            limit: Math.min(32, Math.max(1, count - items.length + skipped), scanCap - scanned),
            paginate: false,
            ...(cursor ? { cursor } : {}),
            consistency: 'strong',
        }))
        const ids = (page?.blobs || []).map(blob => userV2Id(blob.key)).filter(Boolean)
        if (ids.length === 0) break
        sawV2 = true
        scanned += ids.length
        floor = floor ? Math.min(floor, ...ids) : Math.min(...ids)
        const bodies = await measure(timing, 'comments', () => mapWithConcurrency(
            ids,
            id => getJSON(data, blobKeys.comment(id)),
            READ_CONCURRENCY,
        ))
        for (const comment of bodies) {
            if (!comment || !isVisibleFor(comment, viewer)) continue
            if (skipped > 0) {
                skipped -= 1
                continue
            }
            items.push(comment)
        }
        const next = page?.cursor
        if (next && next !== cursor) {
            cursor = next
            if (items.length < count && scanned < scanCap) continue
            return {
                items: items.slice(0, count),
                hasMore: true,
                nextCursor: encodeUserCursor(cursor, floor),
            }
        }
        cursor = undefined
        break
    }

    const hasLegacy = sawV2
        ? await hasLegacyUserCommentsBefore(data, uid, floor, timing)
        : true
    if (sawV2 && items.length >= count) {
        return {
            items: items.slice(0, count),
            hasMore: hasLegacy,
            nextCursor: hasLegacy ? encodeUserCursor(null, floor, 'legacy') : null,
        }
    }

    if (!hasLegacy) return { items, hasMore: false, nextCursor: null }

    // v2 intentionally contains only new writes. Once exhausted, use the unchanged
    // legacy index below the oldest v2 id to avoid returning the dual-written rows twice.
    const legacy = await listLegacyUserComments(data, viewer, uid, {
        count: Math.max(1, count - items.length),
        offset: skipped,
        upperId: sawV2 ? floor : 0,
        timing,
    })
    items.push(...legacy.items.slice(0, count - items.length))
    return {
        items,
        hasMore: legacy.hasMore,
        nextCursor: legacy.nextCursor,
    }
}

function isValidCalendarDate(year, month, day) {
    const probe = new Date(Date.UTC(year, month - 1, day))
    return probe.getUTCFullYear() === year
        && probe.getUTCMonth() === month - 1
        && probe.getUTCDate() === day
}

export async function countComments(data, query) {
    const date = query.get('date') || shanghaiDateString(Date.now())
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
    if (!match) throw httpError(400, '日期格式不正确')
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (!isValidCalendarDate(year, month, day)) throw httpError(400, '日期格式不正确')
    const blobs = await listAll(data, blobKeys.commentsByDatePrefix(date), Infinity)
    return blobs.length
}

/** @param {{timing?: import('./types.js').ServerTiming}} [options] */
export async function setLike(data, commentId, user, liked, options = {}) {
    const { timing } = options
    const comment = await measure(timing, 'comments', () =>
        getJSON(data, blobKeys.comment(commentId)))
    if (!comment || comment.hidden) throw httpError(404, '留言不存在')
    const key = blobKeys.commentLike(commentId, user.id)
    await measure(timing, 'likes', async () => {
        if (liked) {
            await data.setJSON(key, { userId: user.id, createdAt: Date.now() }, { onlyIfNew: true }).catch(error => {
                if (!isPreconditionFailure(error)) throw error
            })
        } else {
            await data.delete(key)
        }
    })
    let likes = await measure(timing, 'likes', () => countLikeRecords(data, commentId))
    const repairKey = blobKeys.commentLikeCountRepair(commentId)
    try {
        let stable = false
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await measure(timing, 'likes', () => data.setJSON(
                blobKeys.commentLikeCountCache(commentId),
                { commentId, count: likes, updatedAt: Date.now() },
            ))
            const verified = await measure(timing, 'likes', () =>
                countLikeRecords(data, commentId))
            if (verified === likes) {
                stable = true
                break
            }
            likes = verified
        }
        if (!stable) throw new Error('点赞计数在缓存更新期间持续变化')
        await data.delete(repairKey).catch(() => {})
    } catch (error) {
        await data.setJSON(repairKey, {
            commentId,
            authoritativeLikes: likes,
            status: 'open',
            createdAt: Date.now(),
            error: String(error?.message || error).slice(0, 300),
        })
        console.error(JSON.stringify({
            event: 'comment_like_count_cache_update_failed',
            commentId,
            likes,
            error: String(error?.message || error).slice(0, 300),
        }))
    }
    return { liked: Boolean(liked), likes }
}

export async function moderateComment(data, commentId, action) {
    const key = blobKeys.comment(commentId)
    const comment = await getJSON(data, key)
    if (!comment) throw httpError(404, '留言不存在')
    if (action === 'delete') {
        // 可恢复顺序:先写 tombstone(失败则中止,状态未变)→ 删正文 → 删用户索引。
        // 用户索引删除失败:写 repair marker(repairs/comment-delete/{id}.json)供迁移/修复任务处理,
        // 不能无标记返回成功。
        await preserveCommentNumberBeforeDelete(data, comment)
        if (comment.number) {
            const seatKey = blobKeys.commentNumber(comment.number)
            const seat = await getJSON(data, seatKey)
            if (seat) {
                try {
                    await data.setJSON(seatKey, {
                        ...seat,
                        commentId: comment.id,
                        number: comment.number,
                        tombstone: true,
                        deletedAt: Date.now(),
                    })
                } catch (error) {
                    console.error(JSON.stringify({
                        event: 'comment_seat_tombstone_failed',
                        commentId,
                        number: comment.number,
                        error: String(error?.message || error).slice(0, 300),
                    }))
                    throw httpError(500, '管理操作失败，请稍后再试')
                }
            }
        }
        // 日期索引保留:今日留言统计口径为「当天曾发布」(见 docs)
        // likes/reports 保留:作为审计记录,不做清理
        await data.delete(key)
        const userIndexKeys = [
            blobKeys.commentByUser(comment.uid, commentId),
            blobKeys.commentByUserV2(comment.uid, commentId),
        ]
        const deleteResults = await Promise.allSettled(userIndexKeys.map(indexKey => data.delete(indexKey)))
        const failedIndexKeys = userIndexKeys.filter((_, index) => deleteResults[index]?.status === 'rejected')
        if (failedIndexKeys.length > 0) {
            const error = deleteResults.find(result => result.status === 'rejected')?.reason
            await data.setJSON(blobKeys.commentDeleteRepair(commentId), {
                commentId,
                number: comment.number ?? null,
                uid: comment.uid,
                step: 'user-index',
                failedIndexKeys,
                status: 'open',
                createdAt: Date.now(),
            }, { onlyIfNew: true }).catch(markerError => {
                console.error(JSON.stringify({
                    event: 'comment_repair_marker_failed',
                    commentId,
                    error: String(markerError?.message || markerError).slice(0, 300),
                }))
            })
            console.error(JSON.stringify({
                event: 'comment_user_index_delete_failed',
                commentId,
                uid: comment.uid,
                error: String(error?.message || error).slice(0, 300),
            }))
        }
        return
    }
    if (!['hide', 'restore'].includes(action)) throw httpError(400, '管理操作无效')
    comment.hidden = action === 'hide'
    comment.updatedAt = Date.now()
    await data.setJSON(key, comment)
}
