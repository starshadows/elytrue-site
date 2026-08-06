import { apiResponse, binaryResponse, readJSON } from '../../http.js'
import { enforceRateLimit } from '../../rate-limit.js'
import { clientIdentity } from '../../middleware/request-context.js'
import { loadImageService } from '../lazy-services.js'

async function serveImage(stores, kind, imageId, cache) {
    const { loadImage } = await loadImageService()
    const image = await loadImage(stores, kind, imageId)
    return binaryResponse(image.buffer, image.contentType, {
        cache,
    })
}

export async function uploadImage(context, stores, path, auth) {
    await enforceRateLimit('upload', clientIdentity(context, auth.user.id))
    const body = await readJSON(context.request, 3 * 1024 * 1024)
    const { cleanupStalePendingImages, saveImage } = await loadImageService()
    const saved = await saveImage(stores, auth.user, body.image, 'comment')
    await cleanupStalePendingImages(stores, auth.user)
    return apiResponse({ imageId: saved.imageId }, { status: 201, message: '图片已上传' })
}

export async function deleteImage(context, stores, path, auth) {
    await enforceRateLimit('upload', clientIdentity(context, auth.user.id))
    const imageId = String(new URL(context.request.url).searchParams.get('imageId') || '')
    const { deletePendingImage } = await loadImageService()
    await deletePendingImage(stores, auth.user, imageId)
    return apiResponse(null, { message: '图片已删除' })
}

export function defaultAvatar(context) {
    return new Response(null, {
        status: 302,
        headers: {
            Location: new URL(
                '/assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png',
                context.request.url,
            ).toString(),
            'Cache-Control': 'no-store',
        },
    })
}

export function avatarImage(context, stores, path) {
    return serveImage(
        stores,
        'avatars',
        path.slice('data/images/avatars/'.length),
        'public, max-age=300, must-revalidate',
    )
}

export function commentImage(context, stores, path) {
    return serveImage(
        stores,
        'comments',
        path.slice('data/images/posts/'.length).replace(/\.[a-z0-9]+$/iu, ''),
        'public, max-age=31536000, immutable',
    )
}
