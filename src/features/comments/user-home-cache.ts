import type { UserCommentPage, UserCommentRecord } from './comment-types'

export const USER_HOME_CACHE_VERSION = 1
export const USER_HOME_CACHE_TTL = 4 * 60_000
const STORAGE_PREFIX = 'elytrue.userHomeComments'

interface StoredUserHomePage {
  version: typeof USER_HOME_CACHE_VERSION
  savedAt: number
  page: UserCommentPage
}

type StorageLike = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

const memoryCache = new Map<string, StoredUserHomePage>()

function browserStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function userHomeCacheKey(
  viewerId: string,
  profileUserId: string,
): string {
  return `${STORAGE_PREFIX}.v${USER_HOME_CACHE_VERSION}:${encodeURIComponent(viewerId)}:${encodeURIComponent(profileUserId)}`
}

function publicPage(page: UserCommentPage): UserCommentPage {
  return {
    items: page.items.map((item): UserCommentRecord => ({
      id: item.id,
      ...(item.number === undefined ? {} : { number: item.number }),
      comment: item.comment,
      image: item.image,
      time: item.time,
    })),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  }
}

function validStoredPage(value: unknown): value is StoredUserHomePage {
  if (typeof value !== 'object' || value === null) return false
  const stored = value as Partial<StoredUserHomePage>
  return (
    stored.version === USER_HOME_CACHE_VERSION &&
    typeof stored.savedAt === 'number' &&
    Number.isFinite(stored.savedAt) &&
    stored.page !== undefined &&
    Array.isArray(stored.page.items) &&
    typeof stored.page.hasMore === 'boolean' &&
    (stored.page.nextCursor === null ||
      typeof stored.page.nextCursor === 'number' ||
      typeof stored.page.nextCursor === 'string')
  )
}

export function getCachedUserHomePage(
  viewerId: string,
  profileUserId: string,
  storage: StorageLike | null = browserStorage(),
): UserCommentPage | null {
  const key = userHomeCacheKey(viewerId, profileUserId)
  let stored = memoryCache.get(key)
  if (!stored && storage) {
    try {
      const raw = storage.getItem(key)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (validStoredPage(parsed)) {
          stored = parsed
          memoryCache.set(key, parsed)
        }
      }
    } catch {
      try {
        storage.removeItem(key)
      } catch {
        // sessionStorage can be unavailable in restricted browser contexts.
      }
    }
  }
  if (!stored || stored.savedAt + USER_HOME_CACHE_TTL <= Date.now()) {
    memoryCache.delete(key)
    try {
      storage?.removeItem(key)
    } catch {
      // Ignore storage failures; the in-memory cache remains usable.
    }
    return null
  }
  return publicPage(stored.page)
}

export function cacheUserHomePage(
  viewerId: string,
  profileUserId: string,
  page: UserCommentPage,
  storage: StorageLike | null = browserStorage(),
): void {
  const key = userHomeCacheKey(viewerId, profileUserId)
  const stored: StoredUserHomePage = {
    version: USER_HOME_CACHE_VERSION,
    savedAt: Date.now(),
    page: publicPage(page),
  }
  memoryCache.set(key, stored)
  try {
    storage?.setItem(key, JSON.stringify(stored))
  } catch {
    // The memory cache still covers the current page.
  }
}

export function invalidateUserHomeCache(): void {
  memoryCache.clear()
  const storage = browserStorage()
  if (!storage) return
  const keys: string[] = []
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(`${STORAGE_PREFIX}.`)) keys.push(key)
    }
    keys.forEach((key) => storage.removeItem(key))
  } catch {
    // Ignore storage failures during logout or session refresh.
  }
}
