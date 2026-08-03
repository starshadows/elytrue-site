import { randomUUID } from 'node:crypto'
import { httpError } from '../http.js'
import { createReportRepository } from '../repositories/report-repository.js'
import { isPreconditionFailure } from '../storage.js'
import { sanitizePlainText } from '../../shared/validation.js'

const INTERNAL_ID_THRESHOLD = 1e12
const NUMBER_SCAN_PAGE_SIZE = 100
const NUMBER_SCAN_MAX_PAGES = 10
const NUMBER_CACHE_TTL_MS = 5 * 60 * 1000
const numberFallbackCaches = new WeakMap()

export function validPublicNumber(value) {
    const number = Number(value)
    return Number.isSafeInteger(number) && number > 0 && number < INTERNAL_ID_THRESHOLD
        ? number
        : null
}

function fallbackCacheFor(data) {
    const now = Date.now()
    const cached = numberFallbackCaches.get(data)
    if (cached && cached.expiresAt > now) return cached.values
    const values = new Map()
    numberFallbackCaches.set(data, {
        values,
        expiresAt: now + NUMBER_CACHE_TTL_MS,
    })
    return values
}

async function findLegacyNumbers(repository, data, commentIds) {
    const unresolved = new Set(commentIds)
    const result = new Map()
    if (unresolved.size === 0) return result

    const cache = fallbackCacheFor(data)
    for (const commentId of unresolved) {
        if (!cache.has(commentId)) continue
        const cachedNumber = validPublicNumber(cache.get(commentId))
        if (cachedNumber) result.set(commentId, cachedNumber)
        unresolved.delete(commentId)
    }
    if (unresolved.size === 0) return result

    let cursor
    for (let page = 0; page < NUMBER_SCAN_MAX_PAGES && unresolved.size > 0; page += 1) {
        const response = await repository.listNumberPage({
            cursor,
            limit: NUMBER_SCAN_PAGE_SIZE,
        })
        const blobs = response?.blobs || []
        for (const blob of blobs) {
            const seat = await repository.getNumberSeat(blob.key).catch(() => null)
            const commentId = Number(seat?.commentId)
            if (!seat?.tombstone || !unresolved.has(commentId)) continue
            const keyNumber = Number(
                String(blob.key).slice(
                    'indexes/comments/number/'.length,
                    -'.json'.length,
                ),
            )
            const number = validPublicNumber(seat.number) ?? validPublicNumber(keyNumber)
            if (!number) continue
            result.set(commentId, number)
            cache.set(commentId, number)
            unresolved.delete(commentId)
        }
        const nextCursor = response?.cursor
        if (
            unresolved.size === 0
            || blobs.length < NUMBER_SCAN_PAGE_SIZE
            || !nextCursor
            || nextCursor === cursor
        ) {
            break
        }
        cursor = nextCursor
    }
    for (const commentId of unresolved) cache.set(commentId, null)
    return result
}

export async function createReport(data, commentId, user, reason) {
    const repository = createReportRepository(data)
    const comment = await repository.getComment(commentId)
    if (!comment) throw httpError(404, '留言不存在')
    if (comment.uid === user.id) throw httpError(403, '不能举报自己的留言')
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
    await repository.setNumberReverse(comment.id, number)
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
    const unresolvedDeletedIds = new Set()
    const entriesByComment = new Map()

    for (const entry of entries) {
        const report = entry.value
        if (!report) continue
        const internalId = Number(report.commentId)
        const reportNumber = validPublicNumber(report.commentNumber)
        const comment = await repository.getComment(report.commentId).catch(() => null)
        let displayId = reportNumber ?? validPublicNumber(comment?.number)
        const deleted = comment === null

        if (!displayId && deleted && Number.isSafeInteger(internalId)) {
            const reverse = await repository.getNumberReverse(internalId).catch(() => null)
            displayId = validPublicNumber(reverse?.number)
            if (!displayId) unresolvedDeletedIds.add(internalId)
        }
        if (!entriesByComment.has(internalId)) entriesByComment.set(internalId, [])
        entriesByComment.get(internalId).push(entry)
        reports.push({
            ...report,
            displayId,
            deleted,
        })
    }

    const legacyNumbers = await findLegacyNumbers(
        repository,
        data,
        unresolvedDeletedIds,
    )
    for (const [commentId, number] of legacyNumbers) {
        await repository.setNumberReverse(commentId, number).catch(() => {})
        for (const entry of entriesByComment.get(commentId) || []) {
            if (validPublicNumber(entry.value?.commentNumber)) continue
            await repository.patch(entry.key, {
                ...entry.value,
                commentNumber: number,
            }).catch(() => {})
        }
    }
    for (const report of reports) {
        if (!report.displayId && report.deleted) {
            report.displayId = legacyNumbers.get(Number(report.commentId)) ?? null
        }
    }
    return reports.sort((a, b) => b.createdAt - a.createdAt)
}
