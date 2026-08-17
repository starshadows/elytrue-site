import { shallowRef } from 'vue'
import type { UserProfile } from './auth-store'

const STORAGE_KEY = 'elytrue.profileHint'

/** Public fields that are safe to render before the session is verified. */
export interface OptimisticProfile {
  userId: string
  uid: number
  name: string
  avatar: string
}

export interface CachedProfileHint extends OptimisticProfile {
  version: 2
  savedAt: number
}

type ProfileHintStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

function browserStorage(): ProfileHintStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readProfileHint(
  storage: ProfileHintStorage | null = browserStorage(),
): CachedProfileHint | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Reflect.get(parsed, 'version') !== 2 ||
      typeof Reflect.get(parsed, 'userId') !== 'string' ||
      typeof Reflect.get(parsed, 'uid') !== 'number' ||
      !Number.isSafeInteger(Reflect.get(parsed, 'uid')) ||
      Reflect.get(parsed, 'uid') < 1 ||
      typeof Reflect.get(parsed, 'name') !== 'string' ||
      typeof Reflect.get(parsed, 'avatar') !== 'string' ||
      typeof Reflect.get(parsed, 'savedAt') !== 'number'
    ) {
      storage.removeItem(STORAGE_KEY)
      return null
    }
    return {
      version: 2,
      userId: Reflect.get(parsed, 'userId'),
      uid: Reflect.get(parsed, 'uid'),
      name: Reflect.get(parsed, 'name'),
      avatar: Reflect.get(parsed, 'avatar'),
      savedAt: Reflect.get(parsed, 'savedAt'),
    }
  } catch {
    try {
      storage.removeItem(STORAGE_KEY)
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
    return null
  }
}

export const profileHint = shallowRef<CachedProfileHint | null>(
  readProfileHint(),
)

export function saveProfileHint(
  profile: Pick<UserProfile, 'avatar' | 'id' | 'name' | 'uid'>,
  storage: ProfileHintStorage | null = browserStorage(),
): void {
  const hint: CachedProfileHint = {
    version: 2,
    userId: profile.id,
    uid: profile.uid,
    name: profile.name,
    avatar: profile.avatar,
    savedAt: Date.now(),
  }
  profileHint.value = hint
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(hint))
  } catch {
    // The in-memory hint still covers this page load.
  }
}

export function clearProfileHint(
  storage: ProfileHintStorage | null = browserStorage(),
): void {
  profileHint.value = null
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // Authentication state must still clear when storage is unavailable.
  }
}
