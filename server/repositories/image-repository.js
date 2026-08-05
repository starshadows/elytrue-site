import { blobKeys, blobPrefixes } from '../domain/blob-keys.js'
import { getJSON, listAll } from '../storage.js'

export function createImageRepository(data, uploads) {
    return Object.freeze({
        getUsage: () => getJSON(data, blobKeys.uploadUsage),
        setUsage: value => data.setJSON(blobKeys.uploadUsage, value),
        getAlias: (kind, imageId) => getJSON(data, blobKeys.imageAlias(kind, imageId)),
        createAlias: (kind, imageId, value) =>
            data.setJSON(blobKeys.imageAlias(kind, imageId), value, { onlyIfNew: true }),
        setAlias: (kind, imageId, value) =>
            data.setJSON(blobKeys.imageAlias(kind, imageId), value),
        deleteAlias: (kind, imageId) => data.delete(blobKeys.imageAlias(kind, imageId)),
        listCommentAliases: (limit = 1000) =>
            listAll(data, blobPrefixes.commentAliases, limit),
        listUserCommentIndexes: (userId, limit = 1000) =>
            listAll(data, blobKeys.commentsByUserPrefix(userId), limit),
        getUserCommentIndex: key => getJSON(data, key),
        getComment: commentId => getJSON(data, blobKeys.comment(commentId)),
        getOperation: key => getJSON(data, key),
        createOperation: (key, value) => data.setJSON(key, value, { onlyIfNew: true }),
        setOperation: (key, value) => data.setJSON(key, value),
        putBlob: (key, value) => uploads.set(key, value),
        getBlob: key => uploads.get(key, {
            type: 'arrayBuffer',
            consistency: 'strong',
        }),
        deleteBlob: key => uploads.delete(key),
    })
}
