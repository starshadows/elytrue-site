import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { blobKeys } from '../server/domain/blob-keys.js'
import { MemoryStore } from '../server/storage.js'
import {
    createReport,
    listReports,
    preserveCommentNumberBeforeDelete,
} from '../server/services/report-service.js'

class CountingStore extends MemoryStore {
    listCalls = []

    async list(options = {}) {
        this.listCalls.push(options)
        return super.list(options)
    }
}

class PaginatedNumberStore extends CountingStore {
    async list(options = {}) {
        if (options.prefix !== 'indexes/comments/number/') {
            return super.list(options)
        }
        this.listCalls.push(options)
        const keys = [...this.values.keys()]
            .filter(key => key.startsWith(options.prefix))
            .sort((left, right) => {
                const leftNumber = Number(left.match(/(\d+)\.json$/u)?.[1] || 0)
                const rightNumber = Number(right.match(/(\d+)\.json$/u)?.[1] || 0)
                return leftNumber - rightNumber
            })
        const offset = Number(options.cursor || 0)
        const limit = Number(options.limit || 100)
        const page = keys.slice(offset, offset + limit)
        const nextOffset = offset + page.length
        return {
            blobs: page.map(key => ({ key, etag: 'memory' })),
            directories: [],
            ...(nextOffset < keys.length ? { cursor: String(nextOffset) } : {}),
        }
    }
}

const author = { id: 'author' }
const reporter = { id: 'reporter' }

async function putComment(data, id, number = 7) {
    await data.setJSON(blobKeys.comment(id), {
        id,
        number,
        uid: author.id,
        createdAt: 1,
    })
}

describe('report public number compatibility', () => {
    test('new reports persist commentNumber and avoid number-index scans', async () => {
        const data = new CountingStore()
        await putComment(data, 123, 7)
        await createReport(data, 123, reporter, 'reason')
        const reports = await listReports(data)
        assert.equal(reports[0].displayId, 7)
        assert.equal(reports[0].deleted, false)
        assert.equal(
            data.listCalls.some(call => call.prefix === 'indexes/comments/number/'),
            false,
        )
    })

    test('an existing comment body supplies a missing legacy number', async () => {
        const data = new CountingStore()
        await putComment(data, 124, 8)
        await data.setJSON(blobKeys.commentReport(124, reporter.id), {
            commentId: 124,
            userId: reporter.id,
            createdAt: 1,
        })
        const reports = await listReports(data)
        assert.equal(reports[0].displayId, 8)
        assert.equal(
            data.listCalls.some(call => call.prefix === 'indexes/comments/number/'),
            false,
        )
    })

    test('a reverse record resolves a deleted legacy comment without scanning', async () => {
        const data = new CountingStore()
        await data.setJSON(blobKeys.commentReport(125, reporter.id), {
            commentId: 125,
            userId: reporter.id,
            createdAt: 1,
        })
        await data.setJSON(blobKeys.commentNumberReverse(125), {
            commentId: 125,
            number: 9,
        })
        const reports = await listReports(data)
        assert.equal(reports[0].displayId, 9)
        assert.equal(reports[0].deleted, true)
        assert.equal(
            data.listCalls.some(call => call.prefix === 'indexes/comments/number/'),
            false,
        )
    })

    test('the bounded legacy fallback backfills reverse and report records', async () => {
        const data = new CountingStore()
        const reportKey = blobKeys.commentReport(126, reporter.id)
        await data.setJSON(reportKey, {
            commentId: 126,
            userId: reporter.id,
            createdAt: 1,
        })
        await data.setJSON(blobKeys.commentNumber(10), {
            commentId: 126,
            tombstone: true,
        })
        const reports = await listReports(data)
        assert.equal(reports[0].displayId, 10)
        const scan = data.listCalls.find(call => call.prefix === 'indexes/comments/number/')
        assert.ok(scan)
        assert.equal(scan.limit, 100)
        assert.notEqual(scan.limit, Infinity)
        assert.equal(
            (await data.get(blobKeys.commentNumberReverse(126), { type: 'json' })).number,
            10,
        )
        assert.equal((await data.get(reportKey, { type: 'json' })).commentNumber, 10)
    })

    test('the legacy fallback follows bounded pages instead of requesting all seats', async () => {
        const data = new PaginatedNumberStore()
        const reportKey = blobKeys.commentReport(128, reporter.id)
        await data.setJSON(reportKey, {
            commentId: 128,
            userId: reporter.id,
            createdAt: 1,
        })
        for (let number = 1; number <= 150; number += 1) {
            await data.setJSON(blobKeys.commentNumber(number), {
                commentId: 1000 + number,
                tombstone: true,
            })
        }
        await data.setJSON(blobKeys.commentNumber(151), {
            commentId: 128,
            tombstone: true,
        })

        const reports = await listReports(data)
        assert.equal(reports[0].displayId, 151)
        const scans = data.listCalls.filter(
            call => call.prefix === 'indexes/comments/number/',
        )
        assert.equal(scans.length, 2)
        assert.ok(scans.every(call => call.limit === 100 && call.paginate === false))
    })

    test('an unresolved bounded fallback is negatively cached for repeated admin reads', async () => {
        const data = new PaginatedNumberStore()
        await data.setJSON(blobKeys.commentReport(129, reporter.id), {
            commentId: 129,
            userId: reporter.id,
            createdAt: 1,
        })
        for (let number = 1; number <= 1001; number += 1) {
            await data.setJSON(blobKeys.commentNumber(number), {
                commentId: 2000 + number,
                tombstone: true,
            })
        }

        const first = await listReports(data)
        assert.equal(first[0].displayId, null)
        const firstScanCount = data.listCalls.filter(
            call => call.prefix === 'indexes/comments/number/',
        ).length
        assert.equal(firstScanCount, 10)

        const second = await listReports(data)
        assert.equal(second[0].displayId, null)
        const secondScanCount = data.listCalls.filter(
            call => call.prefix === 'indexes/comments/number/',
        ).length
        assert.equal(secondScanCount, firstScanCount)
    })

    test('report listing paginates without truncating the API array', async () => {
        const data = new CountingStore()
        for (let index = 1; index <= 1001; index += 1) {
            await data.setJSON(blobKeys.commentReport(index, reporter.id), {
                commentId: index,
                commentNumber: index,
                userId: reporter.id,
                createdAt: index,
            })
        }

        const reports = await listReports(data)
        assert.equal(reports.length, 1001)
        assert.equal(reports[0].commentId, 1001)
        const reportPages = data.listCalls.filter(
            call => call.prefix === 'reports/',
        )
        assert.ok(reportPages.length > 1)
        assert.ok(
            reportPages.every(
                call => call.limit === 100 && call.paginate === false,
            ),
        )
    })

    test('hard deletion preparation preserves numbers for legacy reports', async () => {
        const data = new CountingStore()
        const comment = { id: 127, number: 11, uid: author.id }
        await data.setJSON(blobKeys.commentReport(127, reporter.id), {
            commentId: 127,
            userId: reporter.id,
            createdAt: 1,
        })
        await preserveCommentNumberBeforeDelete(data, comment)
        assert.equal(
            (await data.get(blobKeys.commentNumberReverse(127), { type: 'json' })).number,
            11,
        )
        assert.equal(
            (await data.get(blobKeys.commentReport(127, reporter.id), { type: 'json' }))
                .commentNumber,
            11,
        )
    })
})
