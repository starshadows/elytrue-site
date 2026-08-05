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

const author = { id: 'author' }
const reporter = { id: 'reporter' }

async function putComment(data, id, number = 7) {
    const comment = {
        id,
        number,
        uid: author.id,
        sender: '作者',
        avatar: '',
        comment: '被举报留言',
        image: '',
        replyid: null,
        hidden: false,
        likes: 0,
        createdAt: 1,
        time: 0,
    }
    await data.setJSON(blobKeys.comment(id), comment)
    return comment
}

describe('report public number records', () => {
    test('new reports persist commentNumber without number-index scans', async () => {
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

    test('an existing canonical comment supplies a missing report number', async () => {
        const data = new CountingStore()
        await putComment(data, 124, 8)
        await data.setJSON(blobKeys.commentReport(124, reporter.id), {
            commentId: 124,
            userId: reporter.id,
            createdAt: 1,
        })
        const reports = await listReports(data)
        assert.equal(reports[0].displayId, 8)
    })

    test('delete preparation persists the number in reports before canonical deletion', async () => {
        const data = new CountingStore()
        const comment = await putComment(data, 125, 9)
        await data.setJSON(blobKeys.commentReport(125, reporter.id), {
            commentId: 125,
            userId: reporter.id,
            createdAt: 1,
        })
        await preserveCommentNumberBeforeDelete(data, comment)
        await data.delete(blobKeys.comment(125))
        const reports = await listReports(data)
        assert.equal(reports[0].displayId, 9)
        assert.equal(reports[0].deleted, true)
        assert.equal(
            data.listCalls.some(call => call.prefix === 'indexes/comments/number/'),
            false,
        )
    })
})
