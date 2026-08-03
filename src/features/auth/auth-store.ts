import { computed, reactive, readonly } from 'vue'

export type LoginState = 'loading' | 'authenticated' | 'unauthenticated'

export interface UserProfile {
  id: string
  name: string
  avatar: string
  email?: string
  hasEmail?: boolean
  role?: 'admin' | 'user'
  create_time?: number
}

interface MutableAuthState {
  loginState: LoginState
  userId: string | null
  profile: UserProfile | null
}

export interface AuthAdapter {
  loadProfile(): Promise<UserProfile>
  clearSession(): void
}

export type ProfileAction =
  | 'changeName'
  | 'changeAvatar'
  | 'changeEmail'
  | 'changePassword'
  | 'showMe'
  | 'logout'
  | 'resetToken'

export function createAuthStore(initialAdapter?: AuthAdapter) {
  const mutableState = reactive<MutableAuthState>({
    loginState: 'loading',
    userId: null,
    profile: null,
  })
  let adapter = initialAdapter
  let initialization: Promise<UserProfile | null> | null = null
  let requestGeneration = 0

  function configure(nextAdapter: AuthAdapter): void {
    adapter = nextAdapter
  }

  function requireAdapter(): AuthAdapter {
    if (!adapter) throw new Error('Auth store is not configured')
    return adapter
  }

  function applyProfile(profile: UserProfile): UserProfile {
    mutableState.profile = profile
    mutableState.userId = profile.id
    mutableState.loginState = 'authenticated'
    return profile
  }

  function clearState(): null {
    adapter?.clearSession()
    mutableState.profile = null
    mutableState.userId = null
    mutableState.loginState = 'unauthenticated'
    return null
  }

  function clear(): null {
    requestGeneration += 1
    initialization = null
    return clearState()
  }

  async function requestProfile(
    generation: number,
  ): Promise<UserProfile | null> {
    try {
      const profile = await requireAdapter().loadProfile()
      return generation === requestGeneration
        ? applyProfile(profile)
        : mutableState.profile
    } catch {
      return generation === requestGeneration
        ? clearState()
        : mutableState.profile
    }
  }

  function initialize(): Promise<UserProfile | null> {
    if (!initialization) {
      requestGeneration += 1
      initialization = requestProfile(requestGeneration)
    }
    return initialization
  }

  function refresh(): Promise<UserProfile | null> {
    requestGeneration += 1
    const request = requestProfile(requestGeneration)
    initialization = request
    return request
  }

  async function ready(): Promise<UserProfile | null> {
    return initialization ?? initialize()
  }

  async function ensureAuthenticated(): Promise<boolean> {
    if (mutableState.loginState === 'loading') await ready()
    return mutableState.userId !== null
  }

  return {
    authenticated: computed(
      () =>
        mutableState.loginState === 'authenticated' &&
        mutableState.userId !== null,
    ),
    clear,
    configure,
    ensureAuthenticated,
    initialize,
    ready,
    refresh,
    state: readonly(mutableState),
  }
}

export const authStore = createAuthStore()
