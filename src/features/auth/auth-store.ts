import { computed, reactive, readonly } from 'vue'

export type LoginState = 'loading' | 'authenticated' | 'unauthenticated'

export interface UserProfile {
  id: string
  name: string
  avatar: string
  email?: string
  hasEmail?: boolean
  hasRecoveryKey?: boolean
  role?: 'admin' | 'user'
  create_time?: number
}

interface MutableAuthState {
  loginState: LoginState
  userId: string | null
  profile: UserProfile | null
}

export interface AuthAdapter {
  loadProfile(signal?: AbortSignal): Promise<UserProfile | null | AuthHydration>
  clearSession(): void
  applyHydratedSession?(profile: UserProfile, csrfToken?: string): void
  reportError?(error: unknown): void
}

export interface AuthHydration {
  profile: UserProfile | null
  csrfToken?: string
}

export type AuthHydrationSource =
  | AuthHydration
  | Promise<AuthHydration>
  | ((isCurrent: () => boolean) => Promise<AuthHydration>)

export type ProfileAction =
  | 'changeName'
  | 'changeAvatar'
  | 'changeEmail'
  | 'changePassword'
  | 'recoveryKey'
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
  let sessionEpoch = 0

  function configure(nextAdapter: AuthAdapter): void {
    adapter = nextAdapter
  }

  function requireAdapter(): AuthAdapter {
    if (!adapter) throw new Error('Auth store is not configured')
    return adapter
  }

  function applyProfile(profile: UserProfile, csrfToken?: string): UserProfile {
    adapter?.applyHydratedSession?.(profile, csrfToken)
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
    sessionEpoch += 1
    initialization = null
    return clearState()
  }

  function apply(profile: UserProfile, csrfToken?: string): UserProfile {
    requestGeneration += 1
    const applied = applyProfile(profile, csrfToken)
    initialization = Promise.resolve(applied)
    return applied
  }

  function establish({ profile, csrfToken }: AuthHydration): UserProfile {
    if (!profile) throw new Error('Authenticated session requires a profile')
    sessionEpoch += 1
    return apply(profile, csrfToken)
  }

  function clearIfSessionEpoch(requestEpoch: number): boolean {
    if (requestEpoch !== sessionEpoch) return false
    clear()
    return true
  }

  async function requestProfile(
    generation: number,
    signal?: AbortSignal,
  ): Promise<UserProfile | null> {
    try {
      const loaded = await requireAdapter().loadProfile(signal)
      const { profile, csrfToken } =
        loaded && typeof loaded === 'object' && 'profile' in loaded
          ? loaded
          : { profile: loaded }
      if (!profile) {
        if (generation !== requestGeneration) return mutableState.profile
        sessionEpoch += 1
        return clearState()
      }
      return generation === requestGeneration
        ? applyProfile(profile, csrfToken)
        : mutableState.profile
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        adapter?.reportError?.(error)
      }
      return mutableState.profile
    }
  }

  function initialize(): Promise<UserProfile | null> {
    if (!initialization) {
      requestGeneration += 1
      initialization = requestProfile(requestGeneration)
    }
    return initialization
  }

  function refresh(signal?: AbortSignal): Promise<UserProfile | null> {
    requestGeneration += 1
    const request = requestProfile(requestGeneration, signal)
    initialization = request
    return request
  }

  function hydrate(
    hydration: AuthHydrationSource,
  ): Promise<UserProfile | null> {
    requestGeneration += 1
    const generation = requestGeneration
    const source =
      typeof hydration === 'function'
        ? hydration(() => generation === requestGeneration)
        : hydration
    const request = Promise.resolve(source)
      .then(({ profile, csrfToken }) => {
        if (generation !== requestGeneration) return mutableState.profile
        return profile ? applyProfile(profile, csrfToken) : clearState()
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          adapter?.reportError?.(error)
        }
        return mutableState.profile
      })
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
    apply,
    clear,
    clearIfSessionEpoch,
    configure,
    currentSessionEpoch: () => sessionEpoch,
    ensureAuthenticated,
    establish,
    hydrate,
    initialize,
    ready,
    refresh,
    state: readonly(mutableState),
  }
}

export const authStore = createAuthStore()
