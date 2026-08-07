import { randomUUID } from 'node:crypto'
import { httpError } from '../http.js'
import { createReportRepository } from '../repositories/report-repository.js'
import { isPreconditionFailure } from '../storage.js'
import { sanitizePlainText } from '../../shared/validation.js'

const INTERNAL_ID_THRESHOLD = 1e12

export function validPublicNumber(value) {
    const number = Number(value)
    return Number.isSafeInteger(number) && number > 0 && number < INTERNAL_ID_THRESHOLD
        ? number
        : null
}

export async function createReport(data, commentId, user, reason) {
    const repository = createReportRepository(data)
    const comment = await repository.getComment(commentId)
    if (!comment) throw httpError(404, '留言不存在')
    const cleanReason = sanitizePlainText(reason || '用户举报').slice(0, 500)
    try {
        await repository.create(commentId, user.id, {
            id: randomUUID(),
            commentId,
            commentNumber: validPublicNumber(comment.number),
            userId: user.id,
            reason: cleanReason,
            createdAt: Date.now(),
            status: 'open',
        })
    } catch (error) {
        if (isPreconditionFailure(error)) throw httpError(409, '已举报过该留言')
        throw error
    }
}

export async function preserveCommentNumberBeforeDelete(data, comment) {
    const number = validPublicNumber(comment?.number)
    if (!number) return
    const repository = createReportRepository(data)
    const entries = await repository.listForComment(comment.id)
    for (const entry of entries) {
        if (!entry.value || validPublicNumber(entry.value.commentNumber)) continue
        await repository.patch(entry.key, {
            ...entry.value,
            commentNumber: number,
        })
    }
}

export async function listReports(data) {
    const repository = createReportRepository(data)
    const entries = await repository.list()
    const reports = []
    for (const entry of entries) {
        const report = entry.value
        if (!report) continue
        const comment = await repository.getComment(report.commentId).catch(() => null)
        reports.push({
            ...report,
            selfReport: comment?.uid === report.userId,
            displayId: validPublicNumber(report.commentNumber)
                ?? validPublicNumber(comment?.number),
            deleted: comment === null,
        })
    }
    return reports.sort((a, b) => b.createdAt - a.createdAt)
}
