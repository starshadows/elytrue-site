import FloatMsgs from '../../components/FloatMsgs'
import Popups from '../../components/Popups'
import XHR from '../../net/xhr'
import { logFrontendError } from '../../app/app-events'
import { ApiError } from '../../lib/api-client'
import { markPerformanceEvent } from '../../lib/performance'
import { commentsStore } from '../comments/comments-store'
import { invalidateUserCommentCache } from '../comments/comments-api'
import {
  authStore,
  type AuthHydration,
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
let backgroundVerification: AbortController | undefined

async function requestAuthSession(
  signal?: AbortSignal,
): Promise<AuthHydration> {
  markPerformanceEvent('auth-request-start')
  let response: AuthenticatedSessionResponse | null
  try {
    response = await XHR.get<AuthenticatedSessionResponse | null>(
      'user/me',
      undefined,
      {
        signal,
        silent: true,
        suppressUnauthorizedHandler: true,
        updateCsrfToken: false,
      },
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { profile: null }
    }
    throw error
  }
  markPerformanceEvent('auth-response', {
    authenticated: Boolean(response),
  })
  return response
    ? {
        profile: profileFromSession(response),
        csrfToken: response.csrfToken,
      }
    : { profile: null }
}

function configureAuth(): void {
  if (configured) return
  configured = true
  authStore.configure({
    clearSession() {
      XHR.csrfToken = ''
      clearProfileHint()
    },
    applyHydratedSession(profile, csrfToken) {
      if (csrfToken !== undefined) XHR.csrfToken = csrfToken
      saveProfileHint(profile)
    },
    async loadProfile(signal) {
      return requestAuthSession(signal)
    },
    reportError(error) {
      logFrontendError(error, 'failed to verify authentication')
    },
  })
  XHR.authEpochProvider = () => authStore.currentSessionEpoch()
  XHR.unauthorizedHandler = (requestEpoch) => {
    if (!authStore.clearIfSessionEpoch(requestEpoch)) return
    invalidateUserCommentCache()
    commentsStore.clearViewerLikes()
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

export function loadAuthFallback(): Promise<AuthHydration> {
  configureAuth()
  return requestAuthSession()
}

export async function refreshAuth(
  signal?: AbortSignal,
): Promise<UserProfile | null> {
  configureAuth()
  const profile = await authStore.refresh(signal)
  if (!profile && authStore.state.loginState === 'unauthenticated') {
    invalidateUserCommentCache()
    commentsStore.clearViewerLikes()
  }
  return profile
}

export interface AuthenticatedSessionResponse extends UserProfile {
  csrfToken: string
}

function profileFromSession(
  response: AuthenticatedSessionResponse,
): UserProfile {
  return {
    id: response.id,
    name: response.name,
    avatar: response.avatar,
    ...(response.email === undefined ? {} : { email: response.email }),
    ...(response.hasEmail === undefined ? {} : { hasEmail: response.hasEmail }),
    ...(response.hasRecoveryKey === undefined
      ? {}
      : { hasRecoveryKey: response.hasRecoveryKey }),
    ...(response.role === undefined ? {} : { role: response.role }),
    ...(response.create_time === undefined
      ? {}
      : { create_time: response.create_time }),
  }
}

export function applyAuthenticatedSession(
  response: AuthenticatedSessionResponse,
): UserProfile {
  configureAuth()
  invalidateUserCommentCache()
  return authStore.establish({
    profile: profileFromSession(response),
    csrfToken: response.csrfToken,
  })
}

export function continueAfterAuthentication(): void {
  backgroundVerification?.abort()
  backgroundVerification = new AbortController()
  const verification = backgroundVerification
  void refreshAuth(verification.signal)
    .then((profile) => {
      if (!profile || verification.signal.aborted) return
      return commentsStore.refreshAfterAuthentication()
    })
    .catch((error: unknown) =>
      logFrontendError(error, 'failed to synchronize comments after login'),
    )
}

export function applyUpdatedProfile(profile: UserProfile): UserProfile {
  configureAuth()
  const applied = authStore.apply(profile)
  saveProfileHint(applied)
  return applied
}

export async function ensureLoggedIn(): Promise<boolean> {
  configureAuth()
  if (await authStore.ensureAuthenticated()) return true
  Popups.show('loginPopup')
  return false
}

export async function getCurrentUser(): Promise<UserProfile> {
  const response = await XHR.get<AuthenticatedSessionResponse>(
    'user/me',
    undefined,
    { silentStatuses: [401] },
  )
  return profileFromSession(response)
}

function changeName(): void {
  void getCurrentUser().then((profile) => {
    Popups.show('promptInputPopup', {
      title:
        '<span class="ui zh">修改昵称</span><span class="ui en">Change nickname</span>',
      subtitle: `<span class="ui zh">${profile.hasEmail ? '' : '更改后, <b>将无法使用旧昵称登录</b><br>请确保这是您的账号, 再进行修改, 否则, 请先创建一个自己的账号<br><br>'}输入新昵称</span><span class="ui en">${profile.hasEmail ? '' : "After changing, <b>you won't be able to log in with the old name.</b><br>Make sure this is your account, if not, create a new one.<br><br>"}Enter your new nickname</span>`,
      text: profile.name,
      action(name: string, context: InputActionContext) {
        void XHR.put<UserProfile>('user/update', { name }).then((response) => {
          if (response.code !== 1) return
          applyUpdatedProfile(response.data)
          context.close()
          FloatMsgs.show({
            type: 'success',
            msg: '<span class="ui zh">修改成功</span><span class="ui en">Successfully changed</span>',
          })
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
        void XHR.put<UserProfile>('user/update', { email })
          .then((response) => {
            if (response.code !== 1) return
            applyUpdatedProfile(response.data)
            context.close()
            FloatMsgs.show({
              type: 'success',
              persist: true,
              msg: '<span class="ui zh">邮箱修改成功，请确认新邮箱长期可用</span><span class="ui en">Email updated successfully</span>',
            })
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
