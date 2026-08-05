import { blobKeys } from '../domain/blob-keys.js'
import { getJSON, getJSONPublic } from '../storage.js'

export function createCommentRepository(data) {
    return Object.freeze({
        get: commentId => getJSON(data, blobKeys.comment(commentId)),
        set: (commentId, value, options) =>
            data.setJSON(blobKeys.comment(commentId), value, options),
        delete: commentId => data.delete(blobKeys.comment(commentId)),
        getNumber: number => getJSON(data, blobKeys.commentNumber(number)),
        setNumber: (number, value, options) =>
            data.setJSON(blobKeys.commentNumber(number), value, options),
        deleteNumber: number => data.delete(blobKeys.commentNumber(number)),
        getNumberHint: () => getJSON(data, blobKeys.commentNumberHint),
        setNumberHint: value => data.setJSON(blobKeys.commentNumberHint, value),
        getLatest: publicRead => (publicRead ? getJSONPublic : getJSON)(
            data,
            blobKeys.commentsLatestView,
        ),
        setLatest: value => data.setJSON(blobKeys.commentsLatestView, value),
        deleteLatest: () => data.delete(blobKeys.commentsLatestView),
        setPublicView: (commentId, value) =>
            data.setJSON(blobKeys.commentPublicView(commentId), value),
        deletePublicView: commentId => data.delete(blobKeys.commentPublicView(commentId)),
        setHiddenView: (commentId, value) =>
            data.setJSON(blobKeys.commentHiddenView(commentId), value),
        deleteHiddenView: commentId => data.delete(blobKeys.commentHiddenView(commentId)),
        setUserView: (userId, commentId, value) =>
            data.setJSON(blobKeys.commentByUser(userId, commentId), value),
        deleteUserView: (userId, commentId) =>
            data.delete(blobKeys.commentByUser(userId, commentId)),
        setDateFact: (date, commentId, value) =>
            data.setJSON(blobKeys.commentByDate(date, commentId), value, { onlyIfNew: true }),
        setRepair: (commentId, value) =>
            data.setJSON(blobKeys.commentViewRepair(commentId), value),
        deleteRepair: commentId => data.delete(blobKeys.commentViewRepair(commentId)),
        claimMutation: (commentId, version, value) => data.setJSON(
            blobKeys.commentMutationClaim(commentId, version),
            value,
            { onlyIfNew: true },
        ),
        getMutationClaim: (commentId, version) =>
            getJSON(data, blobKeys.commentMutationClaim(commentId, version)),
        setMutationClaim: (commentId, version, value) =>
            data.setJSON(blobKeys.commentMutationClaim(commentId, version), value),
        deleteMutationClaim: (commentId, version) =>
            data.delete(blobKeys.commentMutationClaim(commentId, version)),
    })
}
