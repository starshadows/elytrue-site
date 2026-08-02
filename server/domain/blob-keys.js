/**
 * EdgeOne Blob key contract.
 *
 * These helpers intentionally preserve the historical strings byte-for-byte.
 * Changing padding, prefixes, suffixes, or identifier normalization would make
 * existing production data unreachable.
 */

const paddedCommentId = id => String(id).padStart(16, '0')

export const blobPrefixes = Object.freeze({
    users: 'users/',
    comments: 'comments/',
    commentNumbers: 'indexes/comments/number/',
    commentUsers: 'indexes/comments/by-user/',
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
    passwordReset: tokenHash => `password-resets/${tokenHash}.json`,
    passwordResetClaim: tokenHash => `password-resets/${tokenHash}.json.claimed`,

    comment: commentId => `${blobPrefixes.comments}${paddedCommentId(commentId)}.json`,
    commentNumber: number => `${blobPrefixes.commentNumbers}${Number(number)}.json`,
    commentsByUserPrefix: userId => `${blobPrefixes.commentUsers}${userId}/`,
    commentByUser: (userId, commentId) =>
        `${blobPrefixes.commentUsers}${userId}/${paddedCommentId(commentId)}.json`,
    commentsByDatePrefix: date => `dates/${date}/`,
    commentByDate: (date, commentId) => `dates/${date}/${paddedCommentId(commentId)}.json`,
    commentNumberHint: 'meta/comments-number-hint.json',
    commentLikePrefix: commentId => `likes/${commentId}/`,
    commentLike: (commentId, userId) => `likes/${commentId}/${userId}.json`,
    commentReport: (commentId, userId) => `reports/${commentId}/${userId}.json`,
    commentDeleteRepair: commentId => `repairs/comment-delete/${commentId}.json`,

    uploadUsage: 'usage/uploads.json',
    imageAlias: (kind, imageId) =>
        `uploads/aliases/${kind === 'avatar' || kind === 'avatars' ? 'avatars' : 'comments'}/${imageId}.json`,
    uploadBlob: (kind, userId, imageId, extension) =>
        `${kind === 'avatar' || kind === 'avatars' ? 'avatars' : 'comments'}/${userId}/${imageId}.${extension}`,
    adminBootstrapClosed: 'system/admin-bootstrap-closed.json',
})
