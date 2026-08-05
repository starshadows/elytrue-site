/**
 * EdgeOne Blob key contract.
 *
 * Comment read-model keys intentionally have no legacy aliases. The site had
 * no production comments when this schema was introduced.
 */

const paddedCommentId = id => String(id).padStart(16, '0')
const invertedCommentId = id => String(Number.MAX_SAFE_INTEGER - Number(id)).padStart(16, '0')

export const blobPrefixes = Object.freeze({
    users: 'users/',
    comments: 'comments/',
    commentNumbers: 'indexes/comments/number/',
    commentUsers: 'indexes/comments/by-user/',
    commentPublicViews: 'views/comments/public/',
    commentHiddenViews: 'views/comments/hidden/',
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
    commentsByUserPrefix: userId => `${blobPrefixes.commentUsers}${userId}/`,
    commentByUser: (userId, commentId) =>
        `${blobPrefixes.commentUsers}${userId}/${invertedCommentId(commentId)}-${paddedCommentId(commentId)}.json`,
    commentPublicView: commentId =>
        `${blobPrefixes.commentPublicViews}${invertedCommentId(commentId)}-${paddedCommentId(commentId)}.json`,
    commentPublicViewsPrefix: blobPrefixes.commentPublicViews,
    commentHiddenView: commentId =>
        `${blobPrefixes.commentHiddenViews}${invertedCommentId(commentId)}-${paddedCommentId(commentId)}.json`,
    commentHiddenViewsPrefix: blobPrefixes.commentHiddenViews,
    commentsLatestView: 'views/comments/latest.json',
    commentsLatestLock: 'operations/comments-latest-lock.json',
    commentsByDatePrefix: date => `dates/${date}/`,
    commentByDate: (date, commentId) => `dates/${date}/${paddedCommentId(commentId)}.json`,
    commentNumberHint: 'meta/comments-number-hint.json',
    commentLikePrefix: commentId => `likes/${commentId}/`,
    commentLike: (commentId, userId) => `likes/${commentId}/${userId}.json`,
    commentReport: (commentId, userId) => `reports/${commentId}/${userId}.json`,
    commentViewRepair: commentId => `repairs/comment-views/${commentId}.json`,
    commentOperation: operationId => `operations/comments/${operationId}.json`,
    commentMutationClaim: (commentId, version) =>
        `operations/comment-mutations/${commentId}/${Number(version)}.json`,

    uploadUsage: 'usage/uploads.json',
    imageUploadOperation: imageId => `operations/image-uploads/${imageId}.json`,
    imageDeleteOperation: imageId => `operations/image-deletes/${imageId}.json`,
    imageAlias: (kind, imageId) =>
        `uploads/aliases/${kind === 'avatar' || kind === 'avatars' ? 'avatars' : 'comments'}/${imageId}.json`,
    uploadBlob: (kind, userId, imageId, extension) =>
        `${kind === 'avatar' || kind === 'avatars' ? 'avatars' : 'comments'}/${userId}/${imageId}.${extension}`,
    adminBootstrapClosed: 'system/admin-bootstrap-closed.json',
})
