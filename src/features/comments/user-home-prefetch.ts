import type { UserCommentPage } from './comment-types'
import { commentsApi } from './comments-api'
import { cacheUserHomePage, userHomeCacheKey } from './user-home-cache'

interface UserHomeRequest {
  promise: Promise<UserCommentPage>
  controller: AbortController
  startedAt: number
}

const requests = new Map<string, UserHomeRequest>()
const REQUEST_REUSE_TTL = 4 * 60_000

export function prefetchUserHomePage({
  viewerId,
  profileUserId,
  signal,
}: {
  viewerId: string
  profileUserId: string
  signal?: AbortSignal
}): Promise<UserCommentPage> {
  const key = userHomeCacheKey(viewerId, profileUserId)
  const current = requests.get(key)
  if (current && current.startedAt + REQUEST_REUSE_TTL > Date.now()) {
    if (signal) {
      if (signal.aborted) current.controller.abort(signal.reason)
      else
        signal.addEventListener(
          'abort',
          () => current.controller.abort(signal.reason),
          { once: true },
        )
    }
    return current.promise
  }

  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else
      signal.addEventListener('abort', () => controller.abort(signal.reason), {
        once: true,
      })
  }
  const request: UserHomeRequest = {
    startedAt: Date.now(),
    controller,
    promise: Promise.resolve(undefined as never),
  }
  request.promise = commentsApi
    .listUser(profileUserId, undefined, controller.signal)
    .then((page) => {
      cacheUserHomePage(viewerId, profileUserId, page)
      return page
    })
    .catch((error: unknown) => {
      if (requests.get(key) === request) requests.delete(key)
      throw error
    })
    .finally(() => {
      if (requests.get(key) === request && controller.signal.aborted)
        requests.delete(key)
    })
  requests.set(key, request)
  return request.promise
}

export function cancelUserHomePrefetch(profileUserId: string): void {
  for (const [key, request] of requests) {
    if (key.endsWith(`:${encodeURIComponent(profileUserId)}`)) {
      request.controller.abort()
      requests.delete(key)
    }
  }
}
