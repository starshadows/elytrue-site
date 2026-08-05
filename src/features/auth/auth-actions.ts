import FloatMsgs from '../../components/FloatMsgs'
import Popups from '../../components/Popups'
import XHR from '../../net/xhr'
import { markPerformanceEvent } from '../../lib/performance'
import { commentsStore } from '../comments/comments-store'
import { invalidateUserCommentCache } from '../comments/comments-api'
import {
  authStore,
  type AuthHydrationSource,
  type ProfileAction,
  type UserProfile,
} from './auth-store'
import { clearProfileHint, saveProfileHint } from './profile-hint'

interface InputActionContext {
  close(): void
  setDisabled(value: boolean): void
}

let configured = false

async function requestAuthProfile(): Promise<UserProfile | null> {
  markPerformanceEvent('auth-request-start')
  const profile = await XHR.get<UserProfile | null>('user/me', undefined, {
    silentStatuses: [401],
  })
  markPerformanceEvent('auth-response', {
    authenticated: Boolean(profile),
  })
  return profile
}

function configureAuth(): void {
  if (configured) return
  configured = true
  authStore.configure({
    clearSession() {
      XHR.token = ''
      XHR.csrfToken = ''
      clearProfileHint()
    },
    applyHydratedSession(profile, csrfToken) {
      if (csrfToken !== undefined) XHR.csrfToken = csrfToken
      saveProfileHint(profile)
    },
    async loadProfile() {
      return requestAuthProfile()
    },
  })
  XHR.unauthorizedHandler = () => {
    invalidateUserCommentCache()
    commentsStore.clearViewerLikes()
    authStore.clear()
  }
}

export function avatarPath(avatar = ''): string {
  return avatar
    ? `/api/data/images/avatars/${encodeURIComponent(avatar)}`
    : '/assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png'
}

export async function initializeAuth(): Promise<UserProfile | null> {
  configureAuth()
  return authStore.initialize()
}

export function hydrateAuth(
  hydration: AuthHydrationSource,
): Promise<UserProfile | null> {
  configureAuth()
  return authStore.hydrate(hydration)
}

export function loadAuthFallback(): Promise<UserProfile | null> {
  configureAuth()
  return requestAuthProfile()
}

export async function refreshAuth(): Promise<UserProfile | null> {
  configureAuth()
  invalidateUserCommentCache()
  const profile = await authStore.refresh()
  if (profile) {
    void commentsStore.hydrateViewerLikes().catch(() => undefined)
  } else commentsStore.clearViewerLikes()
  return profile
}

export async function ensureLoggedIn(): Promise<boolean> {
  configureAuth()
  if (await authStore.ensureAuthenticated()) return true
  Popups.show('loginPopup')
  return false
}

export function getCurrentUser(): Promise<UserProfile> {
  return XHR.get<UserProfile>('user/me', undefined, { silentStatuses: [401] })
}

function changeName(): void {
  void getCurrentUser().then((profile) => {
    Popups.show('promptInputPopup', {
      title:
        '<span class="ui zh">修改昵称</span><span class="ui en">Change nickname</span>',
      subtitle: `<span class="ui zh">${profile.hasEmail ? '' : '更改后, <b>将无法使用旧昵称登录</b><br>请确保这是您的账号, 再进行修改, 否则, 请先创建一个自己的账号<br><br>'}输入新昵称</span><span class="ui en">${profile.hasEmail ? '' : "After changing, <b>you won't be able to log in with the old name.</b><br>Make sure this is your account, if not, create a new one.<br><br>"}Enter your new nickname</span>`,
      text: profile.name,
      action(name: string, context: InputActionContext) {
        void XHR.put('user/update', { name }).then(async (response) => {
          if (response.code !== 1) return
          context.close()
          FloatMsgs.show({
            type: 'success',
            msg: '<span class="ui zh">修改成功</span><span class="ui en">Successfully changed</span>',
          })
          await refreshAuth()
        })
      },
    })
  })
}

function changeEmail(): void {
  void getCurrentUser().then((profile) => {
    Popups.show('promptInputPopup', {
      title:
        '<span class="ui zh">修改邮箱</span><span class="ui en">Change email</span>',
      subtitle:
        '<span class="ui zh">邮箱可作为登录标识，不会公开展示。<br>请输入长期可用的新邮箱</span><span class="ui en">Your email can be used to log in and is never displayed publicly.<br>Enter a long-term email address</span>',
      text: profile.email ?? '',
      action(email: string, context: InputActionContext) {
        context.setDisabled(true)
        void XHR.put('user/update', { email })
          .then(async (response) => {
            if (response.code !== 1) return
            context.close()
            FloatMsgs.show({
              type: 'success',
              persist: true,
              msg: '<span class="ui zh">邮箱修改成功，请确认新邮箱长期可用</span><span class="ui en">Email updated successfully</span>',
            })
            await refreshAuth()
          })
          .finally(() => context.setDisabled(false))
      },
    })
  })
}

function logout(allDevices: boolean): void {
  void XHR.post(allDevices ? 'user/resettoken' : 'user/logout').finally(() => {
    invalidateUserCommentCache()
    commentsStore.clearViewerLikes()
    authStore.clear()
    Popups.close()
    void refreshAuth()
  })
}

export function runProfileAction(action: ProfileAction): void {
  switch (action) {
    case 'changeName':
      changeName()
      break
    case 'changeAvatar':
      Popups.show('setAvatarPopup')
      break
    case 'changeEmail':
      changeEmail()
      break
    case 'changePassword':
      Popups.show('setPasswordPopup')
      break
    case 'recoveryKey':
      Popups.show('recoveryKeySetupPopup')
      break
    case 'showMe':
      Popups.show('userHome', { profile: authStore.state.profile ?? undefined })
      break
    case 'logout':
      logout(false)
      break
    case 'resetToken':
      logout(true)
      break
  }
}
