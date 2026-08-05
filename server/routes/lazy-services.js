let imageServicePromise = null
let accountRecoveryServicePromise = null
let adminServicePromise = null

export function loadImageService() {
    imageServicePromise ??= import('../services/image-service.js')
    return imageServicePromise.catch(error => {
        imageServicePromise = null
        throw error
    })
}

export function loadAccountRecoveryService() {
    accountRecoveryServicePromise ??= import('../services/account-recovery-service.js')
    return accountRecoveryServicePromise.catch(error => {
        accountRecoveryServicePromise = null
        throw error
    })
}

export function loadAdminService() {
    adminServicePromise ??= import('../services/admin-service.js')
    return adminServicePromise.catch(error => {
        adminServicePromise = null
        throw error
    })
}
