import { randomUUID } from 'node:crypto'
import { httpError } from './http.js'
import { getJSON, listAll } from './storage.js'
import { sanitizePlainText, validateComment } from '../shared/validation.js'

function commentKey(id) {
    return `comments/${String(id).padStart(16, '0')}.json`
}

export function newCommentId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

export async function createComment(data, user, body) {
    const commentError = validateComment(body.comment)
    if (commentError) throw httpError(400, commentError)
    const rawImageIds = Array.isArray(body.imageKeys) ? body.imageKeys.map(String) : []
    if (rawImageIds.length > 3) throw httpError(400, '每条留言最多上传 3 张图片')
    const imageIds = [...new Set(rawImageIds)]

    for (const imageId of imageIds) {
        const alias = await getJSON(data, `uploads/aliases/comments/${imageId}.json`)
        if (!alias || alias.userId !== user.id) throw httpError(400, '留言图片无效')
    }

    let replyid = null
    if (body.replyid !== undefined && body.replyid !== null && body.replyid !== '') {
        replyid = Number(body.replyid)
        const reply = await getJSON(data, commentKey(replyid))
        if (!reply) throw httpError(404, '回复的留言不存在')
    }

    const id = newCommentId()
    const createdAt = Date.now()
    const comment = {
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
    await data.setJSON(commentKey(id), comment, { onlyIfNew: true })
    return comment
}

async function decorateComment(data, comment, user) {
    const likes = await listAll(data, `likes/${comment.id}/`, 5000)
    const liked = user
        ? Boolean(await getJSON(data, `likes/${comment.id}/${user.id}.json`))
        : false
    return {
        ...comment,
        likes: likes.length,
        liked,
    }
}

export async function listComments(data, query, viewer) {
    const blobs = await listAll(data, 'comments/', 5000)
    const allComments = []
    for (const blob of blobs) {
        const comment = await getJSON(data, blob.key)
        if (!comment) continue
        allComments.push(comment)
    }

    const displayIds = new Map(
        [...allComments]
            .sort((a, b) =>
                (a.createdAt || a.time * 1000) - (b.createdAt || b.time * 1000)
                || a.id - b.id
            )
            .map((comment, index) => [comment.id, index + 1])
    )

    let comments = allComments.filter(
        comment => !comment.hidden || viewer?.role === 'admin' || viewer?.id === comment.uid
    )
    comments.sort((a, b) => b.id - a.id)

    const uid = query.get('uid')
    if (uid) {
        comments = comments.filter(comment => comment.uid === uid)
        const offset = Math.max(0, Number(query.get('from') || 0))
        const count = Math.min(100, Math.max(1, Number(query.get('count') || 50)))
        comments = comments.slice(offset, offset + count)
    } else {
        const from = Number(query.get('from') || 0)
        const rawCount = Number(query.get('count') || 30)
        const count = Math.min(100, Math.max(1, Math.abs(rawCount)))
        if (from && query.get('count') === '1') {
            comments = comments.filter(comment => comment.id === from).slice(0, 1)
        } else if (from && rawCount < 0) {
            comments = comments.filter(comment => comment.id > from).slice(-count)
        } else if (from) {
            const exactIndex = comments.findIndex(comment => comment.id === from)
            comments = exactIndex >= 0
                ? comments.slice(Math.max(0, exactIndex - Math.floor(count / 2)), exactIndex + Math.ceil(count / 2))
                : comments.filter(comment => comment.id < from).slice(0, count)
        } else {
            const beforeTime = Number(query.get('time') || 0)
            if (beforeTime) comments = comments.filter(comment => comment.time <= beforeTime)
            comments = comments.slice(0, count)
        }
    }
    return Promise.all(comments.map(comment => decorateComment(data, {
        ...comment,
        displayId: displayIds.get(comment.id),
    }, viewer)))
}

export async function setLike(data, commentId, user, liked) {
    const comment = await getJSON(data, commentKey(commentId))
    if (!comment || comment.hidden) throw httpError(404, '留言不存在')
    const key = `likes/${commentId}/${user.id}.json`
    if (liked) {
        await data.setJSON(key, { userId: user.id, createdAt: Date.now() }, { onlyIfNew: true }).catch(error => {
            if (error?.name !== 'PreconditionFailedError') throw error
        })
    } else {
        await data.delete(key)
    }
}

export async function createReport(data, commentId, user, reason) {
    const comment = await getJSON(data, commentKey(commentId))
    if (!comment) throw httpError(404, '留言不存在')
    const cleanReason = sanitizePlainText(reason || '用户举报').slice(0, 500)
    const key = `reports/${commentId}/${user.id}.json`
    await data.setJSON(key, {
        id: randomUUID(),
        commentId,
        userId: user.id,
        reason: cleanReason,
        createdAt: Date.now(),
        status: 'open',
    }, { onlyIfNew: true }).catch(error => {
        if (error?.name !== 'PreconditionFailedError') throw error
    })
}

export async function listReports(data) {
    const blobs = await listAll(data, 'reports/', 5000)
    const reports = []
    for (const blob of blobs) {
        const report = await getJSON(data, blob.key)
        if (report) reports.push(report)
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
