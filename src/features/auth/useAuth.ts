import { computed } from 'vue'
import { authStore, type ProfileAction } from './auth-store'
import { runProfileAction as executeProfileAction } from './auth-actions'

export type { LoginState, ProfileAction, UserProfile } from './auth-store'

export function useAuth() {
  const loggedIn = authStore.authenticated
  const loginState = computed(() => authStore.state.loginState)
  const profile = computed(() => authStore.state.profile)
  const userId = computed(() => authStore.state.userId)

  function runProfileAction(action: ProfileAction): void {
    executeProfileAction(action)
  }

  return {
    loggedIn,
    loginState,
    profile,
    runProfileAction,
    userId,
  }
}
