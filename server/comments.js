import { randomUUID } from 'node:crypto'
import { httpError } from './http.js'
import { getJSON, listAll, isPreconditionFailure } from './storage.js'
import { blobKeys, blobPrefixes } from './domain/blob-keys.js'
import { createReportRepository } from './repositories/report-repository.js'
import { preserveCommentNumberBeforeDelete } from './services/report-service.js'
import { sanitizePlainText, validateComment } from '../shared/validation.js'
const INTERNAL_ID_THRESHOLD = 1e12

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
        await data
            .delete(blobKeys.commentByUser(uid, commentId))
            .catch(error => failures.push(`userIndex:${error?.message || error}`))
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
 */
export async function createComment(data, user, body, { idFactory = newCommentId } = {}) {
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
    if (body.replyid !== undefined && body.replyid !== null && body.replyid !== '') {
        const targetId = await resolveCommentId(data, body.replyid)
        const reply = targetId ? await getJSON(data, blobKeys.comment(targetId)) : null
        if (!reply) throw httpError(404, '回复的留言不存在')
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
        number = await claimCommentNumber(data, comment.id, reservationId)
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
        await data.setJSON(blobKeys.comment(comment.id), comment)
        await data.setJSON(blobKeys.commentByUser(user.id, comment.id), {
            commentId: comment.id,
            createdAt,
        })
        await data.setJSON(blobKeys.commentByDate(date, comment.id), {
            commentId: comment.id,
            createdAt,
        })
        await createReportRepository(data).setNumberReverse(comment.id, number)
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
    return comment
}

/** 读取单条留言,附加展示编号与点赞状态 */
export async function getCommentDetail(data, comment, viewer) {
    const likes = await listAll(data, blobKeys.commentLikePrefix(comment.id), Infinity)
    const liked = viewer
        ? Boolean(await getJSON(data, blobKeys.commentLike(comment.id, viewer.id)))
        : false
    return {
        ...comment,
        displayId: comment.number ?? comment.id,
        likes: likes.length,
        liked,
    }
}

async function listAllCommentKeys(data) {
    const blobs = await listAll(data, blobPrefixes.comments, Infinity)
    return blobs.map(blob => blob.key)
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
    for (let i = 0; i < selected.length && comments.length < count && i < scanCap; i += 1) {
        const comment = await getJSON(data, blobKeys.comment(selected[i]))
        if (!comment) continue
        if (beforeTime) {
            // 有 createdAt 时按毫秒精确过滤;旧数据缺 createdAt 时回落 time 比较
            const createdAt = Number(comment.createdAt)
            if (Number.isFinite(createdAt) && createdAt > boundaryMs) continue
            if (!Number.isFinite(createdAt) && comment.time > beforeTime) continue
        }
        if (!isVisibleFor(comment, viewer)) continue
        comments.push(comment)
    }
    return { items: comments, truncated: comments.length < count && selected.length > scanCap }
}

export async function listComments(data, query, viewer) {
    const uid = query.get('uid')
    if (uid) return listUserComments(data, query, viewer, uid)

    const fromRaw = query.get('from')
    const from = fromRaw ? Number(fromRaw) : 0
    const rawCount = Number(query.get('count') || 30)
    const count = Math.min(100, Math.max(1, Math.abs(rawCount)))
    const beforeTime = Number(query.get('time') || 0)

    // 按公开编号跳转:number=N 返回该条留言(硬删除 tombstone 返回 404)
    const numberParam = query.get('number')
    if (numberParam) {
        const seat = await getJSON(data, blobKeys.commentNumber(Number(numberParam)))
        if (!seat || seat.tombstone) throw httpError(404, '留言不存在')
        const comment = seat?.commentId
            ? await getJSON(data, blobKeys.comment(Number(seat.commentId)))
            : null
        if (!comment) throw httpError(404, '留言不存在')
        if (comment.hidden && viewer?.role !== 'admin' && viewer?.id !== comment.uid) {
            return []
        }
        return [await getCommentDetail(data, comment, viewer)]
    }

    const keys = await listAllCommentKeys(data)
    const ids = keys.map(keyToId).filter(Boolean)

    // 按可见留言数量收集(count=1 与居中窗口保持跳转语义)
    const collected = await collectVisibleComments(data, ids, {
        count,
        from,
        rawCount,
        beforeTime,
        viewer,
        centered: Boolean(from && rawCount !== 1 && ids.includes(from)),
    })

    // 旧数据(未迁移)缺少 number 字段时,用 id 顺序作为展示编号
    const needFallback = collected.items.some(comment => !comment.number)
    const fallbackRanks = needFallback
        ? new Map(ids.map((id, index) => [id, index + 1]))
        : null

    const items = await Promise.all(collected.items.map(comment => getCommentDetail(data, {
        ...comment,
        number: comment.number ?? fallbackRanks?.get(comment.id) ?? comment.id,
    }, viewer)))
    return { items, hasMore: collected.truncated }
}

async function listUserComments(data, query, viewer, uid) {
    const offset = Math.max(0, Number(query.get('from') || 0))
    const cursor = Number(query.get('cursor') || 0)
    const count = Math.min(100, Math.max(1, Number(query.get('count') || 50)))

    const blobs = await listAll(data, blobKeys.commentsByUserPrefix(uid), Infinity)
    const ids = blobs.map(blob => keyToId(blob.key.replace(/^indexes\/comments\/by-user\/[^/]+\//u, 'comments/')))
        .filter(Boolean)
        .sort((a, b) => b - a)

    const pageWindow = cursor ? ids.filter(id => id < cursor) : ids

    // 按可见留言数量分页:扫描到收集够 count 条或窗口结束;
    // nextCursor 记录「最后扫描到的原始索引位」,即使 items 为空(整页隐藏)也能继续
    const items = []
    let hasMore = false
    let nextCursor = null
    const scanCap = Math.max(200, count * 20 + 200)
    let skippedOffset = offset
    let index = 0
    for (; index < pageWindow.length && items.length < count && index < scanCap; index += 1) {
        const comment = await getJSON(data, blobKeys.comment(pageWindow[index]))
        if (!comment) continue
        if (!isVisibleFor(comment, viewer)) continue
        if (skippedOffset > 0) {
            skippedOffset -= 1
            continue
        }
        items.push(comment)
    }
    // 收集满一页后继续只读探测剩余窗口，避免尾部只有隐藏留言时误报 hasMore。
    // 探测仍受同一 scanCap 限制；达到上限但还有原始索引时保守返回 true。
    let probeIndex = index
    while (probeIndex < pageWindow.length && probeIndex < scanCap) {
        const comment = await getJSON(data, blobKeys.comment(pageWindow[probeIndex]))
        probeIndex += 1
        if (comment && isVisibleFor(comment, viewer)) {
            hasMore = true
            break
        }
    }
    if (!hasMore && probeIndex < pageWindow.length) hasMore = true
    // nextCursor = 最后「已消费」的原始索引位(下次请求从它之后继续)
    if (hasMore && index > 0) nextCursor = pageWindow[index - 1]
    return { items, hasMore, nextCursor }
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

export async function setLike(data, commentId, user, liked) {
    const comment = await getJSON(data, blobKeys.comment(commentId))
    if (!comment || comment.hidden) throw httpError(404, '留言不存在')
    const key = blobKeys.commentLike(commentId, user.id)
    if (liked) {
        await data.setJSON(key, { userId: user.id, createdAt: Date.now() }, { onlyIfNew: true }).catch(error => {
            if (!isPreconditionFailure(error)) throw error
        })
    } else {
        await data.delete(key)
    }
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
        try {
            await data.delete(blobKeys.commentByUser(comment.uid, commentId))
        } catch (error) {
            await data.setJSON(blobKeys.commentDeleteRepair(commentId), {
                commentId,
                number: comment.number ?? null,
                uid: comment.uid,
                step: 'user-index',
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
