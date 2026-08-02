import { randomUUID } from 'node:crypto'
import { httpError } from './http.js'
import { getJSON, listAll, isPreconditionFailure } from './storage.js'
import { sanitizePlainText, validateComment } from '../shared/validation.js'

function commentKey(id) {
    return `comments/${String(id).padStart(16, '0')}.json`
}

function commentNumberKey(number) {
    return `indexes/comments/number/${Number(number)}.json`
}

function userCommentsKey(uid, id) {
    return `indexes/comments/by-user/${uid}/${String(id).padStart(16, '0')}.json`
}

function dateCommentsKey(date, id) {
    return `dates/${date}/${String(id).padStart(16, '0')}.json`
}

const NUMBER_HINT_KEY = 'meta/comments-number-hint.json'
const INTERNAL_ID_THRESHOLD = 1e12

export function newCommentId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000)
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
async function claimCommentNumber(data, commentId) {
    const hint = Number((await getJSON(data, NUMBER_HINT_KEY))?.value || 0)
    let number = hint + 1
    for (let attempt = 0; attempt < 2000; attempt += 1) {
        try {
            await data.setJSON(commentNumberKey(number), {
                commentId,
                createdAt: Date.now(),
            }, { onlyIfNew: true })
            await data.setJSON(NUMBER_HINT_KEY, { value: number, updatedAt: Date.now() }).catch(() => {})
            return number
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            number += 1
        }
    }
    throw httpError(500, '留言编号分配失败，请稍后再试')
}

/**
 * 把「公开编号或内部 ID」解析为内部 ID。
 * 公开编号(小数值)优先查编号索引;旧数据未迁移时回退按内部 ID 直查。
 */
export async function resolveCommentId(data, value) {
    const raw = Number(value)
    if (!Number.isSafeInteger(raw) || raw <= 0) return null
    if (raw >= INTERNAL_ID_THRESHOLD) return raw
    const seat = await getJSON(data, commentNumberKey(raw))
    if (seat?.commentId) return Number(seat.commentId)
    const legacy = await getJSON(data, commentKey(raw))
    return legacy ? raw : null
}

export async function createComment(data, user, body) {
    const commentError = validateComment(body.comment)
    if (commentError) throw httpError(400, commentError)
    const rawImageIds = Array.isArray(body.imageKeys) ? body.imageKeys.map(String) : []
    if (rawImageIds.length > 3) throw httpError(400, '每条留言最多上传 3 张图片')
    const imageIds = [...new Set(rawImageIds)]

    const aliases = []
    for (const imageId of imageIds) {
        const alias = await getJSON(data, `uploads/aliases/comments/${imageId}.json`)
        if (!alias || alias.userId !== user.id) throw httpError(400, '留言图片无效')
        aliases.push({ imageId, alias })
    }

    let replyid = null
    if (body.replyid !== undefined && body.replyid !== null && body.replyid !== '') {
        const targetId = await resolveCommentId(data, body.replyid)
        const reply = targetId ? await getJSON(data, commentKey(targetId)) : null
        if (!reply) throw httpError(404, '回复的留言不存在')
        replyid = targetId
    }

    const createdAt = Date.now()
    let id = newCommentId()
    const number = await claimCommentNumber(data, id)
    let comment
    for (let attempt = 0; attempt < 5; attempt += 1) {
        comment = {
            id,
            number,
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
            await data.setJSON(commentKey(id), comment, { onlyIfNew: true })
            break
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            id = newCommentId()
        }
    }
    if (!comment || id <= 0) throw httpError(500, '留言创建失败，请稍后再试')

    await data.setJSON(userCommentsKey(user.id, id), { commentId: id, createdAt }).catch(() => {})
    await data.setJSON(dateCommentsKey(shanghaiDateString(createdAt), id), { commentId: id, createdAt }).catch(() => {})

    for (const { imageId, alias } of aliases) {
        if (alias.status !== 'active') {
            alias.status = 'active'
            await data.setJSON(`uploads/aliases/comments/${imageId}.json`, alias).catch(() => {})
        }
    }
    return comment
}

/** 读取单条留言,附加展示编号与点赞状态 */
export async function getCommentDetail(data, comment, viewer) {
    const likes = await listAll(data, `likes/${comment.id}/`, Infinity)
    const liked = viewer
        ? Boolean(await getJSON(data, `likes/${comment.id}/${viewer.id}.json`))
        : false
    return {
        ...comment,
        displayId: comment.number ?? comment.id,
        likes: likes.length,
        liked,
    }
}

async function listAllCommentKeys(data) {
    const blobs = await listAll(data, 'comments/', Infinity)
    return blobs.map(blob => blob.key)
}

function keyToId(key) {
    const match = String(key).match(/^comments\/(\d+)\.json$/u)
    return match ? Number(match[1]) : null
}

export async function listComments(data, query, viewer) {
    const uid = query.get('uid')
    if (uid) return listUserComments(data, query, viewer, uid)

    const fromRaw = query.get('from')
    const from = fromRaw ? Number(fromRaw) : 0
    const rawCount = Number(query.get('count') || 30)
    const count = Math.min(100, Math.max(1, Math.abs(rawCount)))
    const beforeTime = Number(query.get('time') || 0)

    // 按公开编号跳转:number=N 返回该条留言
    const numberParam = query.get('number')
    if (numberParam) {
        const seat = await getJSON(data, commentNumberKey(Number(numberParam)))
        const comment = seat?.commentId
            ? await getJSON(data, commentKey(Number(seat.commentId)))
            : null
        if (!comment) throw httpError(404, '留言不存在')
        if (comment.hidden && viewer?.role !== 'admin' && viewer?.id !== comment.uid) {
            return []
        }
        return [await getCommentDetail(data, comment, viewer)]
    }

    const keys = await listAllCommentKeys(data)
    const ids = keys.map(keyToId).filter(Boolean)

    // 只读窗口内的留言正文,不再全量读取
    let targetIds = []
    if (from && rawCount === 1) {
        const target = await resolveCommentId(data, from)
        targetIds = target ? [target] : []
    } else if (from && rawCount < 0) {
        const idsAbove = ids.filter(id => id > from)
        targetIds = idsAbove.slice(-count)
    } else if (from) {
        const exact = ids.includes(from)
        if (exact) {
            const index = ids.indexOf(from)
            targetIds = ids.slice(Math.max(0, index - Math.floor(count / 2)), index + Math.ceil(count / 2))
        } else {
            targetIds = ids.filter(id => id < from).slice(-count)
        }
    } else if (beforeTime) {
        // id ≈ createdAt*1000,上界放宽 1 秒后按 time 精确过滤
        const upperBound = beforeTime * 1000 + 1000
        targetIds = ids.filter(id => id <= upperBound).slice(-(count * 2))
    } else {
        targetIds = ids.slice(-count)
    }

    const comments = []
    for (const id of targetIds) {
        const comment = await getJSON(data, commentKey(id))
        if (comment) comments.push(comment)
    }
    if (beforeTime) {
        comments.splice(0, comments.length, ...comments.filter(comment => comment.time <= beforeTime))
    }
    const visible = comments
        .filter(comment => !comment.hidden || viewer?.role === 'admin' || viewer?.id === comment.uid)
        .sort((a, b) => b.id - a.id)
        .slice(0, count)

    // 旧数据(未迁移)缺少 number 字段时,用 id 顺序作为展示编号
    const needFallback = visible.some(comment => !comment.number)
    const fallbackRanks = needFallback
        ? new Map(ids.map((id, index) => [id, index + 1]))
        : null

    return Promise.all(visible.map(comment => getCommentDetail(data, {
        ...comment,
        number: comment.number ?? fallbackRanks.get(comment.id) ?? comment.id,
    }, viewer)))
}

async function listUserComments(data, query, viewer, uid) {
    const offset = Math.max(0, Number(query.get('from') || 0))
    const cursor = Number(query.get('cursor') || 0)
    const count = Math.min(100, Math.max(1, Number(query.get('count') || 50)))

    const blobs = await listAll(data, `indexes/comments/by-user/${uid}/`, Infinity)
    const ids = blobs.map(blob => keyToId(blob.key.replace(/^indexes\/comments\/by-user\/[^/]+\//u, 'comments/')))
        .filter(Boolean)
        .sort((a, b) => b - a)

    let window = ids
    if (cursor) window = window.filter(id => id < cursor)
    const hasMore = window.length > offset + count
    const targetIds = window.slice(offset, offset + count)

    const comments = []
    for (const id of targetIds) {
        const comment = await getJSON(data, commentKey(id))
        if (comment && (!comment.hidden || viewer?.role === 'admin' || viewer?.id === comment.uid)) {
            comments.push(comment)
        }
    }
    const items = await Promise.all(comments.map(comment => getCommentDetail(data, comment, viewer)))
    return { items, hasMore }
}

export async function countComments(data, query) {
    const date = query.get('date') || shanghaiDateString(Date.now())
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
    if (!match) throw httpError(400, '日期格式不正确')
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
        throw httpError(400, '日期格式不正确')
    }
    const blobs = await listAll(data, `dates/${date}/`, Infinity)
    return blobs.length
}

export async function setLike(data, commentId, user, liked) {
    const comment = await getJSON(data, commentKey(commentId))
    if (!comment || comment.hidden) throw httpError(404, '留言不存在')
    const key = `likes/${commentId}/${user.id}.json`
    if (liked) {
        await data.setJSON(key, { userId: user.id, createdAt: Date.now() }, { onlyIfNew: true }).catch(error => {
            if (!isPreconditionFailure(error)) throw error
        })
    } else {
        await data.delete(key)
    }
}

export async function createReport(data, commentId, user, reason) {
    const comment = await getJSON(data, commentKey(commentId))
    if (!comment) throw httpError(404, '留言不存在')
    if (comment.uid === user.id) throw httpError(403, '不能举报自己的留言')
    const cleanReason = sanitizePlainText(reason || '用户举报').slice(0, 500)
    const key = `reports/${commentId}/${user.id}.json`
    try {
        await data.setJSON(key, {
            id: randomUUID(),
            commentId,
            userId: user.id,
            reason: cleanReason,
            createdAt: Date.now(),
            status: 'open',
        }, { onlyIfNew: true })
    } catch (error) {
        if (isPreconditionFailure(error)) throw httpError(409, '已举报过该留言')
        throw error
    }
}

export async function listReports(data) {
    const blobs = await listAll(data, 'reports/', Infinity)
    const reports = []
    for (const blob of blobs) {
        const report = await getJSON(data, blob.key)
        if (!report) continue
        const comment = await getJSON(data, commentKey(report.commentId)).catch(() => null)
        reports.push({
            ...report,
            displayId: comment?.number ?? report.commentId,
        })
    }
    return reports.sort((a, b) => b.createdAt - a.createdAt)
}

export async function moderateComment(data, commentId, action) {
    const key = commentKey(commentId)
    const comment = await getJSON(data, key)
    if (!comment) throw httpError(404, '留言不存在')
    if (action === 'delete') {
        await data.delete(key)
        return
    }
    if (!['hide', 'restore'].includes(action)) throw httpError(400, '管理操作无效')
    comment.hidden = action === 'hide'
    comment.updatedAt = Date.now()
    await data.setJSON(key, comment)
}
