import { adminModerate, adminReports, adminUsage, bootstrapAdmin } from './admin.js'
import { login, logout, logoutAll, me, register } from './auth.js'
import { bootstrap } from './bootstrap.js'
import {
    commentCount,
    commentVisibility,
    comments,
    likeComment,
    postComment,
    publicComments,
    reportComment,
    unlikeComment,
    viewerLikes,
} from './comments.js'
import { health } from './health.js'
import {
    avatarImage,
    commentImage,
    defaultAvatar,
    deleteImage,
    uploadImage,
} from './images.js'
import { recoverUser, updateRecoveryKey } from './recovery.js'
import { findUsers, updateProfile } from './users.js'

export const API_ROUTE_HANDLERS = Object.freeze({
    health,
    register,
    login,
    logout,
    logoutAll,
    me,
    bootstrap,
    findUsers,
    updateProfile,
    recoverUser,
    updateRecoveryKey,
    uploadImage,
    deleteImage,
    defaultAvatar,
    avatarImage,
    commentImage,
    comments,
    publicComments,
    commentCount,
    commentVisibility,
    viewerLikes,
    postComment,
    likeComment,
    unlikeComment,
    reportComment,
    bootstrapAdmin,
    adminReports,
    adminModerate,
    adminUsage,
})
