import { randomUUID } from 'node:crypto'
import { blobKeys, blobPrefixes } from '../domain/blob-keys.js'
import { contentTypeForKey, decodeBase64Image, validateImage } from '../images.js'
import { httpError } from '../http.js'
import { createImageRepository } from '../repositories/image-repository.js'
import { isPreconditionFailure } from '../storage.js'

export const BLOB_FREE_BYTES = 1024 * 1024 * 1024
export const UPLOAD_STOP_BYTES = Math.floor(BLOB_FREE_BYTES * 0.9)
export const UPLOAD_WARNING_BYTES = Math.floor(BLOB_FREE_BYTES * 0.8)

const MAX_AVATAR_BYTES = 1024 * 1024
const MAX_COMMENT_IMAGE_BYTES = 2 * 1024 * 1024
const STALE_PENDING_MS = 24 * 60 * 60 * 1000
const usageWriteQueue = new Map()

function enqueueUsageWrite(key, task) {
    const previous = usageWriteQueue.get(key) || Promise.resolve()
    const next = previous.then(task, task)
    usageWriteQueue.set(key, next.then(() => {}, () => {}))
    return next
}

export async function adjustUploadUsage(stores, delta, adjustmentId = '') {
    const repository = createImageRepository(stores.data, stores.uploads)
    return enqueueUsageWrite(blobKeys.uploadUsage, async () => {
        const current = await repository.getUsage() || { uploadedBytes: 0 }
        const adjustments = { ...(current.adjustments || {}) }
        if (adjustmentId && Number.isFinite(Number(adjustments[adjustmentId]))) {
            return Math.max(0, Number(current.uploadedBytes || 0))
        }
        const uploadedBytes = Math.max(
            0,
            Math.round(Number(current.uploadedBytes || 0) + delta),
        )
        if (adjustmentId) adjustments[adjustmentId] = Number(delta)
        const next = {
            ...current,
            uploadedBytes,
            ...(adjustmentId ? { adjustments } : {}),
            updatedAt: Date.now(),
            warning: uploadedBytes >= UPLOAD_WARNING_BYTES,
        }
        await repository.setUsage(next)
        return uploadedBytes
    })
}

async function hasUsageAdjustment(stores, adjustmentId) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const usage = await repository.getUsage() || {}
    return Number.isFinite(Number(usage.adjustments?.[adjustmentId]))
}

export function validateImageUpload(base64, kind) {
    const maxBytes = kind === 'avatar' ? MAX_AVATAR_BYTES : MAX_COMMENT_IMAGE_BYTES
    const buffer = decodeBase64Image(base64, maxBytes)
    const image = validateImage(buffer, maxBytes)
    return { buffer, image }
}

export async function saveImage(stores, user, base64, kind) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const { buffer, image } = validateImageUpload(base64, kind)
    const usage = await repository.getUsage() || { uploadedBytes: 0 }
    if (Number(usage.uploadedBytes || 0) + buffer.length >= UPLOAD_STOP_BYTES) {
        throw httpError(507, '图片存储空间接近免费额度上限，已暂停新图片上传')
    }

    const imageId = randomUUID()
    const blobKey = blobKeys.uploadBlob(kind, user.id, imageId, image.ext)
    const operationKey = blobKeys.imageUploadOperation(imageId)
    const now = Date.now()
    const alias = {
        imageId,
        userId: user.id,
        blobKey,
        contentType: image.type,
        width: image.width,
        height: image.height,
        size: buffer.length,
        status: 'pending',
        createdAt: now,
        operationId: imageId,
    }
    let operation = {
        version: 1,
        operationId: imageId,
        imageId,
        kind,
        userId: user.id,
        blobKey,
        size: buffer.length,
        desiredState: 'present',
        phase: 'started',
        usageApplied: false,
        createdAt: now,
        updatedAt: now,
    }
    await repository.createOperation(operationKey, operation)
    let aliasCreated = false
    try {
        await repository.putBlob(
            blobKey,
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        )
        operation = { ...operation, phase: 'blob-written', updatedAt: Date.now() }
        await repository.setOperation(operationKey, operation)
        await repository.createAlias(kind, imageId, alias)
        aliasCreated = true
        operation = { ...operation, phase: 'alias-written', updatedAt: Date.now() }
        await repository.setOperation(operationKey, operation)
    } catch (error) {
        let compensated = false
        try {
            if (aliasCreated) await repository.deleteAlias(kind, imageId)
            await repository.deleteBlob(blobKey)
            compensated = true
        } catch (compensationError) {
            console.error(JSON.stringify({
                event: 'upload_compensation_failed',
                imageId,
                error: String(compensationError?.message || compensationError).slice(0, 300),
            }))
        }
        await repository.setOperation(operationKey, {
            ...operation,
            phase: compensated ? 'rolled-back' : 'compensation-needed',
            lastError: String(error?.message || error).slice(0, 300),
            updatedAt: Date.now(),
        }).catch(() => {})
        throw error
    }

    let uploadedBytes = Number(usage.uploadedBytes || 0)
    try {
        uploadedBytes = await adjustUploadUsage(stores, buffer.length, `image-upload:${imageId}`)
        operation = { ...operation, phase: 'committed', usageApplied: true, updatedAt: Date.now() }
    } catch (error) {
        operation = {
            ...operation,
            phase: 'usage-repair-needed',
            lastError: String(error?.message || error).slice(0, 300),
            updatedAt: Date.now(),
        }
        console.error(JSON.stringify({
            event: 'upload_usage_update_failed',
            imageId,
            error: operation.lastError,
        }))
    }
    await repository.setOperation(operationKey, operation).catch(() => {})
    if (uploadedBytes >= UPLOAD_WARNING_BYTES) {
        console.warn('Elytrue Blob usage has reached the 80% warning threshold.')
    }
    return { imageId, blobKey, size: buffer.length }
}

function operationError(error) {
    return String(error?.message || error).slice(0, 300)
}

async function recordAvatarRepair(repository, operation, phase, error) {
    const now = Date.now()
    const lastError = operationError(error)
    const repairedOperation = {
        ...operation,
        phase,
        lastError,
        updatedAt: now,
    }
    await repository.setOperation(
        blobKeys.avatarUpdateOperation(operation.operationId),
        repairedOperation,
    ).catch(() => {})
    await repository.setRepair(blobKeys.avatarUpdateRepair(operation.operationId), {
        version: 1,
        operationId: operation.operationId,
        userId: operation.userId,
        oldAvatarId: operation.oldAvatarId || '',
        newAvatarId: operation.newAvatarId || '',
        phase,
        status: 'open',
        createdAt: operation.createdAt,
        updatedAt: now,
        lastError,
    }).catch(() => {})
    console.error(JSON.stringify({
        event: 'avatar_update_repair_needed',
        operationId: operation.operationId,
        userId: operation.userId,
        phase,
        error: lastError,
    }))
    return repairedOperation
}

export async function markAvatarUpdateRepairNeeded(stores, operation, error) {
    const repository = createImageRepository(stores.data, stores.uploads)
    return recordAvatarRepair(repository, operation, 'repair-needed', error)
}

async function deleteOwnedIndexes(data, keys, userId) {
    for (const key of keys || []) {
        const index = await data.get(key, {
            type: 'json',
            consistency: 'strong',
        })
        if (index?.userId === userId) await data.delete(key)
    }
}

export async function prepareAvatarUpdate(stores, user, preparedImage, oldAvatarId, deps = {}) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const operationId = deps.operationId || randomUUID()
    const operationKey = blobKeys.avatarUpdateOperation(operationId)
    let operation = await repository.getOperation(operationKey)
    if (operation && operation.userId !== user.id) throw httpError(409, '头像更新操作冲突')

    if (!operation) {
        const now = Date.now()
        const imageId = preparedImage ? operationId : ''
        const blobKey = preparedImage
            ? blobKeys.uploadBlob('avatar', user.id, imageId, preparedImage.image.ext)
            : ''
        const alias = preparedImage
            ? {
                imageId,
                userId: user.id,
                blobKey,
                contentType: preparedImage.image.type,
                width: preparedImage.image.width,
                height: preparedImage.image.height,
                size: preparedImage.buffer.length,
                status: 'pending',
                createdAt: now,
                operationId,
            }
            : null
        operation = {
            version: 1,
            operationId,
            userId: user.id,
            oldAvatarId: oldAvatarId || '',
            newAvatarId: imageId,
            blobKey,
            size: preparedImage?.buffer.length || 0,
            phase: preparedImage ? 'started' : 'prepared',
            usageApplied: false,
            createdAt: now,
            updatedAt: now,
            lastError: null,
            profileIndexKeys: deps.profileIndexKeys || [],
            oldProfileIndexKeys: deps.oldProfileIndexKeys || [],
            ...(alias ? { alias } : {}),
        }
        await repository.createOperation(operationKey, operation)
    }

    if (!operation.newAvatarId) return operation
    if (!preparedImage && operation.phase !== 'prepared') {
        throw httpError(409, '头像更新操作缺少图片数据')
    }

    try {
        const usage = await repository.getUsage() || { uploadedBytes: 0 }
        if (
            operation.phase === 'started'
            && Number(usage.uploadedBytes || 0) + Number(operation.size || 0) >= UPLOAD_STOP_BYTES
        ) {
            throw httpError(507, '图片存储空间接近免费额度上限，已暂停新图片上传')
        }
        if (operation.phase === 'started') {
            const buffer = preparedImage.buffer
            await repository.putBlob(
                operation.blobKey,
                buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            )
            operation = { ...operation, phase: 'blob-written', updatedAt: Date.now() }
            await repository.setOperation(operationKey, operation)
        }
        if (operation.phase === 'blob-written') {
            try {
                await repository.createAlias('avatar', operation.newAvatarId, operation.alias)
            } catch (error) {
                if (!isPreconditionFailure(error)) throw error
                const existing = await repository.getAlias('avatar', operation.newAvatarId)
                if (existing?.operationId !== operation.operationId) throw error
            }
            operation = { ...operation, phase: 'alias-pending', updatedAt: Date.now() }
            await repository.setOperation(operationKey, operation)
        }
        if (['alias-pending', 'usage-adjusting'].includes(operation.phase)) {
            operation = { ...operation, phase: 'usage-adjusting', updatedAt: Date.now() }
            await repository.setOperation(operationKey, operation)
            await adjustUploadUsage(
                stores,
                Number(operation.size || 0),
                `avatar-update:${operation.operationId}:add`,
            )
            operation = {
                ...operation,
                phase: 'prepared',
                usageApplied: true,
                lastError: null,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        }
        return operation
    } catch (error) {
        await compensateAvatarUpdate(stores, operation)
        throw error
    }
}

export async function compensateAvatarUpdate(stores, inputOperation) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const operationKey = blobKeys.avatarUpdateOperation(inputOperation.operationId)
    let operation = await repository.getOperation(operationKey) || inputOperation
    if (operation.phase === 'rolled-back') return operation
    const failures = []

    if (operation.newAvatarId) {
        try {
            const alias = await repository.getAlias('avatar', operation.newAvatarId)
            if (alias && alias.operationId !== operation.operationId) {
                throw new Error('avatar alias is owned by another operation')
            }
            if (alias) await repository.deleteAlias('avatar', operation.newAvatarId)
        } catch (error) {
            failures.push(error)
        }
        try {
            if (operation.blobKey) await repository.deleteBlob(operation.blobKey)
        } catch (error) {
            failures.push(error)
        }
        try {
            const adjustmentId = `avatar-update:${operation.operationId}:add`
            const usageApplied = operation.usageApplied
                || await hasUsageAdjustment(stores, adjustmentId)
            const deleted = await hasUsageAdjustment(
                stores,
                `avatar-delete:${operation.newAvatarId}`,
            )
            if (usageApplied && !deleted) {
                await adjustUploadUsage(
                    stores,
                    -Number(operation.size || 0),
                    `avatar-update:${operation.operationId}:rollback`,
                )
            }
        } catch (error) {
            failures.push(error)
        }
    }

    if (failures.length > 0) {
        return recordAvatarRepair(repository, operation, 'compensation-needed', failures[0])
    }
    try {
        await deleteOwnedIndexes(stores.data, operation.profileIndexKeys, operation.userId)
    } catch (error) {
        return recordAvatarRepair(repository, operation, 'compensation-needed', error)
    }
    operation = {
        ...operation,
        phase: 'rolled-back',
        usageApplied: false,
        lastError: null,
        updatedAt: Date.now(),
    }
    try {
        await repository.setOperation(operationKey, operation)
        await repository.deleteRepair(blobKeys.avatarUpdateRepair(operation.operationId)).catch(() => {})
        return operation
    } catch (error) {
        return recordAvatarRepair(repository, operation, 'compensation-needed', error)
    }
}

export async function deleteAvatar(stores, userId, imageId) {
    if (!imageId) return
    const repository = createImageRepository(stores.data, stores.uploads)
    const operationKey = blobKeys.avatarDeleteOperation(imageId)
    let operation = await repository.getOperation(operationKey)
    if (!operation) {
        const alias = await repository.getAlias('avatar', imageId)
        if (!alias) return
        if (alias.userId !== userId) throw new Error('avatar is owned by another user')
        const now = Date.now()
        operation = {
            version: 1,
            operationId: randomUUID(),
            imageId,
            userId,
            blobKey: alias.blobKey,
            size: Number(alias.size || 0),
            phase: 'started',
            usageApplied: false,
            createdAt: now,
            updatedAt: now,
            lastError: null,
        }
        try {
            await repository.createOperation(operationKey, operation)
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            operation = await repository.getOperation(operationKey)
        }
    }
    if (!operation || operation.userId !== userId) throw new Error('avatar delete operation conflict')
    if (operation.phase === 'committed') return

    try {
        if (operation.phase === 'started') {
            await repository.deleteAlias('avatar', imageId)
            operation = {
                ...operation,
                phase: 'alias-deleted',
                lastError: null,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        }
        if (operation.phase === 'alias-deleted') {
            await repository.deleteBlob(operation.blobKey)
            operation = {
                ...operation,
                phase: 'blob-deleted',
                lastError: null,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        }
        if (['blob-deleted', 'usage-adjusting', 'usage-repair-needed'].includes(operation.phase)) {
            operation = { ...operation, phase: 'usage-adjusting', updatedAt: Date.now() }
            await repository.setOperation(operationKey, operation)
            await adjustUploadUsage(
                stores,
                -Number(operation.size || 0),
                `avatar-delete:${imageId}`,
            )
            operation = {
                ...operation,
                phase: 'committed',
                usageApplied: true,
                lastError: null,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        }
    } catch (error) {
        operation = {
            ...operation,
            phase: operation.phase === 'usage-adjusting' ? 'usage-repair-needed' : operation.phase,
            lastError: operationError(error),
            updatedAt: Date.now(),
        }
        await repository.setOperation(operationKey, operation).catch(() => {})
        throw error
    }
}

export async function commitAvatarUpdate(stores, inputOperation, updatedUser) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const operationKey = blobKeys.avatarUpdateOperation(inputOperation.operationId)
    let operation = await repository.getOperation(operationKey) || inputOperation
    if (updatedUser.avatarKey !== operation.newAvatarId) {
        const error = new Error('user record does not reference the prepared avatar')
        await recordAvatarRepair(repository, operation, 'repair-needed', error)
        throw httpError(500, '头像更新未完成，请稍后重试')
    }

    if (operation.newAvatarId) {
        try {
            const alias = await repository.getAlias('avatar', operation.newAvatarId)
            if (!alias || alias.operationId !== operation.operationId) {
                throw new Error('pending avatar alias is missing')
            }
            const blob = await repository.getBlob(alias.blobKey)
            if (!blob) throw new Error('pending avatar blob is missing')
            if (alias.status !== 'active') {
                await repository.setAlias('avatar', operation.newAvatarId, {
                    ...alias,
                    status: 'active',
                    activatedAt: Date.now(),
                })
            }
            operation = {
                ...operation,
                phase: 'active',
                lastError: null,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        } catch (error) {
            await recordAvatarRepair(repository, operation, 'repair-needed', error)
            throw httpError(500, '头像更新未完成，请稍后重试')
        }
    } else {
        operation = { ...operation, phase: 'active', updatedAt: Date.now() }
        await repository.setOperation(operationKey, operation)
    }

    if (operation.oldAvatarId && operation.oldAvatarId !== operation.newAvatarId) {
        try {
            await deleteAvatar(stores, operation.userId, operation.oldAvatarId)
        } catch (error) {
            await recordAvatarRepair(repository, operation, 'cleanup-needed', error)
            return { ...operation, phase: 'cleanup-needed' }
        }
    }
    try {
        await deleteOwnedIndexes(
            stores.data,
            operation.oldProfileIndexKeys,
            operation.userId,
        )
    } catch (error) {
        await recordAvatarRepair(repository, operation, 'cleanup-needed', error)
        return { ...operation, phase: 'cleanup-needed' }
    }
    try {
        operation = {
            ...operation,
            phase: 'committed',
            lastError: null,
            updatedAt: Date.now(),
        }
        await repository.setOperation(operationKey, operation)
        await repository.deleteRepair(blobKeys.avatarUpdateRepair(operation.operationId)).catch(() => {})
        return operation
    } catch (error) {
        await recordAvatarRepair(repository, operation, 'repair-needed', error)
        throw httpError(500, '头像更新未完成，请稍后重试')
    }
}

export async function loadImage(stores, kind, imageId) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const alias = await repository.getAlias(kind, imageId)
    if (!alias?.blobKey) throw httpError(404, '图片不存在')
    if ((kind === 'avatar' || kind === 'avatars') && alias.status !== 'active') {
        throw httpError(404, '图片不存在')
    }
    const buffer = await repository.getBlob(alias.blobKey)
    if (!buffer) throw httpError(404, '图片不存在')
    return {
        buffer,
        contentType: alias.contentType || contentTypeForKey(alias.blobKey),
    }
}

export async function deletePendingImage(stores, user, imageId) {
    if (!/^[a-f0-9-]{36}$/iu.test(imageId)) throw httpError(400, '图片编号无效')
    const repository = createImageRepository(stores.data, stores.uploads)
    const operationKey = blobKeys.imageDeleteOperation(imageId)
    let operation = await repository.getOperation(operationKey)
    if (operation) {
        if (operation.userId !== user.id) throw httpError(404, '图片不存在')
        if (operation.phase === 'committed') return
        if (!operation.lastError) throw httpError(409, '图片正在删除，请稍后再试')
    }
    if (!operation) {
        const alias = await repository.getAlias('comments', imageId)
        if (!alias || alias.userId !== user.id) throw httpError(404, '图片不存在')
        if (alias.status !== 'pending') throw httpError(409, '图片已关联留言，无法删除')
        operation = {
            version: 1,
            operationId: randomUUID(),
            imageId,
            kind: 'comment',
            userId: user.id,
            alias,
            blobKey: alias.blobKey,
            size: Number(alias.size || 0),
            desiredState: 'absent',
            phase: 'started',
            usageApplied: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }
        try {
            await repository.createOperation(operationKey, operation)
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            operation = await repository.getOperation(operationKey)
            if (operation?.phase === 'committed') return
            if (!operation?.lastError) throw httpError(409, '图片正在删除，请稍后再试')
        }
    }
    if (!operation || operation.userId !== user.id) throw httpError(404, '图片不存在')
    if (operation.phase === 'committed') return
    if (operation.phase === 'usage-repair-needed') return

    if (operation.phase === 'started') {
        try {
            await repository.deleteBlob(operation.blobKey)
            operation = {
                ...operation,
                phase: 'blob-deleted',
                lastError: undefined,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        } catch (error) {
            await repository.setOperation(operationKey, {
                ...operation,
                lastError: String(error?.message || error).slice(0, 300),
                updatedAt: Date.now(),
            }).catch(() => {})
            console.error(JSON.stringify({
                event: 'upload_delete_blob_failed',
                imageId,
                error: String(error?.message || error).slice(0, 300),
            }))
            throw httpError(500, '图片删除失败，请稍后再试')
        }
    }
    if (operation.phase === 'blob-deleted') {
        try {
            await repository.deleteAlias('comments', imageId)
            operation = {
                ...operation,
                phase: 'alias-deleted',
                lastError: undefined,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        } catch (error) {
            await repository.setOperation(operationKey, {
                ...operation,
                lastError: String(error?.message || error).slice(0, 300),
                updatedAt: Date.now(),
            }).catch(() => {})
            console.error(JSON.stringify({
                event: 'upload_alias_delete_failed',
                imageId,
                error: String(error?.message || error).slice(0, 300),
            }))
            throw httpError(500, '图片删除失败，请稍后再试')
        }
    }
    if (!operation.usageApplied) {
        try {
            operation = {
                ...operation,
                phase: 'usage-adjusting',
                lastError: undefined,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        } catch {
            throw httpError(500, '图片删除失败，请稍后再试')
        }
        try {
            await adjustUploadUsage(
                stores,
                -Number(operation.size || 0),
                `image-delete:${imageId}`,
            )
            operation = {
                ...operation,
                usageApplied: true,
                phase: 'alias-deleted',
                lastError: undefined,
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation)
        } catch (error) {
            operation = {
                ...operation,
                phase: 'usage-repair-needed',
                usageApplied: false,
                lastError: String(error?.message || error).slice(0, 300),
                updatedAt: Date.now(),
            }
            await repository.setOperation(operationKey, operation).catch(() => {})
            throw httpError(500, '图片删除失败，请稍后再试')
        }
    }
    await repository.setOperation(operationKey, {
        ...operation,
        phase: 'committed',
        updatedAt: Date.now(),
    })
}

export async function cleanupStalePendingImages(stores, user) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const cutoff = Date.now() - STALE_PENDING_MS
    const blobs = await repository.listCommentAliases().catch(() => [])
    let userIndexBlobs
    try {
        userIndexBlobs = await repository.listUserCommentIndexes(user.id)
    } catch (error) {
        console.error(JSON.stringify({
            event: 'pending_image_cleanup_index_unavailable',
            userId: user.id,
            error: String(error?.message || error).slice(0, 300),
        }))
        return
    }
    let referencedIds = null
    if (userIndexBlobs.length > 0) {
        const referenced = new Set()
        for (const blob of userIndexBlobs) {
            const comment = await repository.getUserCommentIndex(blob.key).catch(() => null)
            if (comment?.image) {
                for (const imageId of String(comment.image).split(',')) {
                    if (imageId) referenced.add(imageId)
                }
            }
        }
        referencedIds = referenced
    }

    for (const blob of blobs) {
        const imageId = String(blob.key).slice(
            blobPrefixes.commentAliases.length,
            -'.json'.length,
        )
        const alias = await repository.getAlias('comments', imageId).catch(() => null)
        if (!alias || alias.userId !== user.id || alias.status !== 'pending') continue
        if (Number(alias.createdAt || 0) > cutoff) continue
        if (referencedIds?.has(alias.imageId)) {
            console.error(JSON.stringify({
                event: 'pending_image_cleanup_skipped_referenced',
                userId: user.id,
                imageId: alias.imageId,
            }))
            continue
        }
        try {
            await deletePendingImage(stores, user, imageId)
            console.log(JSON.stringify({
                event: 'pending_image_cleanup',
                success: true,
                userId: user.id,
                imageId: alias.imageId,
            }))
        } catch (error) {
            console.error(JSON.stringify({
                event: 'pending_image_cleanup',
                success: false,
                userId: user.id,
                imageId: alias.imageId,
                error: String(error?.message || error).slice(0, 300),
            }))
        }
    }
}

export async function getUploadUsage(stores) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const usage = await repository.getUsage() || { uploadedBytes: 0 }
    return {
        ...usage,
        warningAt: UPLOAD_WARNING_BYTES,
        uploadsStopAt: UPLOAD_STOP_BYTES,
        freeQuotaReference: BLOB_FREE_BYTES,
    }
}
