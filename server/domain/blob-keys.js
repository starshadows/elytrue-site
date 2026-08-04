/**
 * EdgeOne Blob key contract.
 *
 * These helpers intentionally preserve the historical strings byte-for-byte.
 * Changing padding, prefixes, suffixes, or identifier normalization would make
 * existing production data unreachable.
 */

const paddedCommentId = id => String(id).padStart(16, '0')
const invertedCommentId = id => String(Number.MAX_SAFE_INTEGER - Number(id)).padStart(16, '0')

export const blobPrefixes = Object.freeze({
    users: 'users/',
    comments: 'comments/',
    commentNumbers: 'indexes/comments/number/',
    commentUsers: 'indexes/comments/by-user/',
    commentUsersV2: 'indexes/comments/by-user-v2/',
    commentAliases: 'uploads/aliases/comments/',
    avatarAliases: 'uploads/aliases/avatars/',
    reports: 'reports/',
    repairs: 'repairs/',
})

export const blobKeys = Object.freeze({
    user: userId => `users/${userId}.json`,
    userNameIndex: nameHash => `indexes/users/name/${nameHash}.json`,
    userEmailIndex: emailHash => `indexes/users/email/${emailHash}.json`,
    session: tokenHash => `sessions/${tokenHash}.json`,
    recoveryKeyClaim: (userId, version) =>
        `recovery-key-claims/${userId}/${Number(version)}.json`,

    comment: commentId => `${blobPrefixes.comments}${paddedCommentId(commentId)}.json`,
    commentNumber: number => `${blobPrefixes.commentNumbers}${Number(number)}.json`,
    commentNumberReverse: commentId =>
        `indexes/comments/by-id/${paddedCommentId(commentId)}.json`,
    commentsByUserPrefix: userId => `${blobPrefixes.commentUsers}${userId}/`,
    commentByUser: (userId, commentId) =>
        `${blobPrefixes.commentUsers}${userId}/${paddedCommentId(commentId)}.json`,
    commentsByUserV2Prefix: userId => `${blobPrefixes.commentUsersV2}${userId}/`,
    commentByUserV2: (userId, commentId) =>
        `${blobPrefixes.commentUsersV2}${userId}/${invertedCommentId(commentId)}-${paddedCommentId(commentId)}.json`,
    commentsByDatePrefix: date => `dates/${date}/`,
    commentByDate: (date, commentId) => `dates/${date}/${paddedCommentId(commentId)}.json`,
    commentNumberHint: 'meta/comments-number-hint.json',
    commentLikePrefix: commentId => `likes/${commentId}/`,
    commentLike: (commentId, userId) => `likes/${commentId}/${userId}.json`,
    commentLikeCountCache: commentId => `cache/comment-like-count/${commentId}.json`,
    commentReport: (commentId, userId) => `reports/${commentId}/${userId}.json`,
    commentDeleteRepair: commentId => `repairs/comment-delete/${commentId}.json`,
    commentLikeCountRepair: commentId => `repairs/comment-like-count/${commentId}.json`,

    uploadUsage: 'usage/uploads.json',
    imageUploadOperation: imageId => `operations/image-uploads/${imageId}.json`,
    imageDeleteOperation: imageId => `operations/image-deletes/${imageId}.json`,
    imageAlias: (kind, imageId) =>
        `uploads/aliases/${kind === 'avatar' || kind === 'avatars' ? 'avatars' : 'comments'}/${imageId}.json`,
    uploadBlob: (kind, userId, imageId, extension) =>
        `${kind === 'avatar' || kind === 'avatars' ? 'avatars' : 'comments'}/${userId}/${imageId}.${extension}`,
    adminBootstrapClosed: 'system/admin-bootstrap-closed.json',
})
