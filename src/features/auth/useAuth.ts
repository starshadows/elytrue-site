import { computed } from 'vue'
import { requireController } from '../../app/controller'

export type ProfileAction =
  | 'changeName'
  | 'changeAvatar'
  | 'changeEmail'
  | 'changePassword'
  | 'showMe'
  | 'logout'
  | 'resetToken'

export function useAuth() {
  const loggedIn = computed(
    () => requireController().User.LoggedOnUserId !== null,
  )

  function runProfileAction(action: ProfileAction): void {
    requireController().User[action]()
  }

  return { loggedIn, runProfileAction }
}
