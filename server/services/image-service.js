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

export async function adjustUploadUsage(stores, delta) {
    const repository = createImageRepository(stores.data, stores.uploads)
    return enqueueUsageWrite(blobKeys.uploadUsage, async () => {
        const current = await repository.getUsage() || { uploadedBytes: 0 }
        const uploadedBytes = Math.max(
            0,
            Math.round(Number(current.uploadedBytes || 0) + delta),
        )
        const next = {
            ...current,
            uploadedBytes,
            updatedAt: Date.now(),
            warning: uploadedBytes >= UPLOAD_WARNING_BYTES,
        }
        await repository.setUsage(next)
        return uploadedBytes
    })
}

export async function saveImage(stores, user, base64, kind) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const maxBytes = kind === 'avatar' ? MAX_AVATAR_BYTES : MAX_COMMENT_IMAGE_BYTES
    const buffer = decodeBase64Image(base64, maxBytes)
    const image = validateImage(buffer, maxBytes)
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
        status: kind === 'avatar' ? 'active' : 'pending',
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
        uploadedBytes = await adjustUploadUsage(stores, buffer.length)
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

export async function loadImage(stores, kind, imageId) {
    const repository = createImageRepository(stores.data, stores.uploads)
    const alias = await repository.getAlias(kind, imageId)
    if (!alias?.blobKey) throw httpError(404, '图片不存在')
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
            await adjustUploadUsage(stores, -Number(operation.size || 0))
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
