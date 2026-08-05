import { blobKeys, blobPrefixes } from '../domain/blob-keys.js'
import { getJSON } from '../storage.js'

const REPORT_PAGE_SIZE = 100

async function listEntries(data, prefix) {
    const entries = []
    let cursor
    do {
        const response = await data.list({
            prefix,
            cursor,
            limit: REPORT_PAGE_SIZE,
            paginate: false,
            consistency: 'strong',
        })
        const blobs = response?.blobs || []
        entries.push(...await Promise.all(blobs.map(async blob => ({
            key: blob.key,
            value: await getJSON(data, blob.key),
        }))))
        const nextCursor = response?.cursor
        if (
            blobs.length < REPORT_PAGE_SIZE
            || !nextCursor
            || nextCursor === cursor
        ) {
            break
        }
        cursor = nextCursor
    } while (true)
    return entries
}

export function createReportRepository(data) {
    return Object.freeze({
        create: (commentId, userId, report) =>
            data.setJSON(blobKeys.commentReport(commentId, userId), report, { onlyIfNew: true }),
        getComment: commentId => getJSON(data, blobKeys.comment(commentId)),
        list: () => listEntries(data, blobPrefixes.reports),
        listForComment: commentId =>
            listEntries(data, `${blobPrefixes.reports}${commentId}/`),
        patch: (key, report) => data.setJSON(key, report),
    })
}
