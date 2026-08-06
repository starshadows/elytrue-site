<template>
  <div class="userHome" @scroll="handleScroll">
    <div v-if="!profileReady" class="userProfilePlaceholder" aria-busy="true">
      <div class="userProfilePlaceholderAvatar"></div>
      <div>
        <i></i>
        <i></i>
      </div>
    </div>
    <div v-else class="userinfo">
      <StableAvatar
        :src="convertAvatarPath(user.avatar)"
        :alt="`${user.name}的头像`"
        loading="eager"
        role="button"
        tabindex="0"
        @click="viewUserAvatar"
        @keydown.enter="viewUserAvatar"
        @keydown.space.prevent="viewUserAvatar"
      />
      <div>
        <div>{{ user.name }}</div>
        <div>
          <span>UID: {{ user.id }}&nbsp;&nbsp;</span>
          <span v-if="user.create_time !== undefined">
            <span class="ui zh">注册时间: </span
            ><span class="ui en">Joined </span>
            {{ new Date(user.create_time * 1000).toLocaleDateString() }}
          </span>
        </div>
      </div>
    </div>
    <div v-if="showAuthHint" class="userAuthLoadingHint">
      <span class="ui zh">正在确认登录状态…</span>
      <span class="ui en">Checking sign-in status…</span>
    </div>
    <div v-if="canManage" class="useraction">
      <div>
        <img src="/res/edit.svg" /><span class="ui zh">编辑资料</span
        ><span class="ui en">Edit profile</span>
        <ul>
          <li @click="userAction('changeName')">
            <span class="ui zh">修改昵称</span
            ><span class="ui en">Change nickname</span>
          </li>
          <li @click="userAction('changeAvatar')">
            <span class="ui zh">修改头像</span
            ><span class="ui en">Change avatar</span>
          </li>
          <li @click="userAction('changeEmail')">
            <span class="ui zh">修改邮箱</span
            ><span class="ui en">Change email</span>
          </li>
          <li @click="userAction('changePassword')">
            <span class="ui zh">修改密码</span
            ><span class="ui en">Change password</span>
          </li>
          <li @click="userAction('recoveryKey')">
            <span class="ui zh">{{
              user.hasRecoveryKey ? '重新生成恢复密钥' : '生成恢复密钥'
            }}</span>
            <span class="ui en">{{
              user.hasRecoveryKey
                ? 'Regenerate recovery key'
                : 'Generate recovery key'
            }}</span>
          </li>
        </ul>
      </div>
      <div>
        <img src="/res/logout.svg" /><span class="ui zh">退出登录</span
        ><span class="ui en">Log out</span>
        <ul>
          <li @click="userAction('logout')">
            <span class="ui zh">退出登录 (当前设备)</span
            ><span class="ui en">Log out (from this device)</span>
          </li>
          <li style="color: red" @click="userAction('resetToken')">
            <span class="ui zh">退出登录 (所有设备)</span
            ><span class="ui en">Log out (from all devices)</span>
          </li>
        </ul>
      </div>
      <div
        v-if="user.role === 'admin'"
        role="button"
        tabindex="0"
        @click="openAdmin"
        @keydown.enter="openAdmin"
        @keydown.space.prevent="openAdmin"
      >
        <img src="/res/edit.svg" alt="" /><span class="ui zh"
          >管理举报与留言</span
        ><span class="ui en">Moderation</span>
      </div>
    </div>
    <div
      v-if="showCommentsLoader"
      class="userCommentsLoading"
      aria-label="正在加载留言"
    >
      <span class="ui zh">正在加载留言…</span>
      <span class="ui en">Loading messages…</span>
    </div>
    <div v-if="commentsError" class="userCommentsError">
      <span class="ui zh">留言加载失败</span>
      <span class="ui en">Failed to load messages</span>
      <button type="button" @click="getComments()">
        <span class="ui zh">重试</span><span class="ui en">Retry</span>
      </button>
    </div>
    <div
      v-for="(item, index) in comments"
      :key="`${item.id}`"
      class="userCommentItem"
    >
      <p>
        {{ item.timeStr }}<span>#{{ item.number ?? item.id }}</span>
      </p>
      <p>
        <span
          role="button"
          tabindex="0"
          @click="gotoComment(index)"
          @keydown.enter="gotoComment(index)"
          @keydown.space.prevent="gotoComment(index)"
          >{{ item.comment }}</span
        >
        <i></i>
        <img
          v-for="image in item.images"
          :key="image"
          :src="`/api/data/images/posts/${image}.jpg`"
          loading="lazy"
          alt="留言图片"
          role="button"
          tabindex="0"
          @click="viewImageUrl(`/api/data/images/posts/${image}.jpg`)"
          @keydown.enter="viewImageUrl(`/api/data/images/posts/${image}.jpg`)"
          @keydown.space.prevent="
            viewImageUrl(`/api/data/images/posts/${image}.jpg`)
          "
        />
      </p>
    </div>
    <h4 v-if="toEnd && !commentsError">
      <span class="ui zh">- 共 {{ comments.length }} 条留言 -</span>
      <span class="ui en">- Total {{ comments.length }} messages -</span>
    </h4>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { avatarPath, runProfileAction } from '../../features/auth/auth-actions'
import { authStore, type UserProfile } from '../../features/auth/auth-store'
import type { OptimisticProfile } from '../../features/auth/profile-hint'
import type { UserCommentPage } from '../../features/comments/comment-types'
import { commentsApi } from '../../features/comments/comments-api'
import { commentsStore } from '../../features/comments/comments-store'
import { getCachedUserHomePage } from '../../features/comments/user-home-cache'
import { createViewLifecycle } from '../../features/comments/user-home-lifecycle'
import {
  cancelUserHomePrefetch,
  prefetchUserHomePage,
} from '../../features/comments/user-home-prefetch'
import XHR from '../../net/xhr'
import { markPerformanceEvent } from '../../lib/performance'
import FloatMsgs from '../FloatMsgs'
import ImgViewer from '../ImgViewer'
import StableAvatar from '../StableAvatar.vue'
import Popups from './index'

interface DisplayUser {
  id: string
  name: string
  avatar: string
  create_time?: number
  role?: 'admin' | 'user'
  hasRecoveryKey?: boolean
}

interface UserComment {
  id: number
  number?: number
  time: number
  timeStr: string
  comment: string
  images: string[]
}

const props = defineProps<{
  id?: string
  name?: string
  avatar?: string
  profile?: UserProfile
  optimisticProfile?: OptimisticProfile
  loadingAuth?: boolean
  popupClosing?: boolean
  popupId?: number
}>()

const initialProfile = props.profile
  ? { ...props.profile }
  : props.optimisticProfile
    ? {
        id: props.optimisticProfile.userId,
        name: props.optimisticProfile.name,
        avatar: props.optimisticProfile.avatar,
      }
    : { id: props.id ?? '', name: props.name ?? '', avatar: props.avatar ?? '' }
const user = ref<DisplayUser>(initialProfile)
const confirmedProfile = ref<UserProfile | null>(props.profile ?? null)
const showAction = ref(Boolean(props.profile))
const profileReady = ref(
  Boolean(props.profile || props.optimisticProfile || (props.id && props.name)),
)
const showAuthHint = ref(false)
const comments = ref<UserComment[]>([])
const scrollPaused = ref(false)
const loadingComments = ref(false)
const showCommentsLoader = ref(false)
const commentsError = ref(false)
const toEnd = ref(false)
const nextCursor = ref<number | string | null>(null)
const canManage = computed(
  () => showAction.value && confirmedProfile.value?.id === user.value.id,
)
let loaderTimer: number | undefined
let authLoaderTimer: number | undefined
let lifecycle = createViewLifecycle()
let profileReadyMarked = false
let startedUserId: string | null = null
let sessionGeneration = 0
const pendingCursorRequests = new Set<string>()
const completedCursorRequests = new Set<string>()

watch(
  () => authStore.state.profile,
  (profile) => {
    if (!profile || profile.id !== user.value.id) return
    user.value = profile
    showAction.value = true
  },
)

function currentViewerId(): string {
  if (authStore.state.userId) return authStore.state.userId
  return props.loadingAuth && !confirmedProfile.value
    ? user.value.id
    : 'anonymous'
}

watch(
  () => props.popupClosing,
  (closing) => {
    if (closing) lifecycle.dispose()
  },
)

watch(
  () => props.loadingAuth,
  (loading) => {
    if (authLoaderTimer !== undefined) window.clearTimeout(authLoaderTimer)
    if (!loading) {
      authLoaderTimer = undefined
      showAuthHint.value = false
      return
    }
    authLoaderTimer = window.setTimeout(() => {
      showAuthHint.value = true
      authLoaderTimer = undefined
    }, 400)
  },
  { immediate: true },
)

watch(loadingComments, (loading) => {
  if (loaderTimer !== undefined) window.clearTimeout(loaderTimer)
  if (!loading) {
    loaderTimer = undefined
    showCommentsLoader.value = false
    return
  }
  loaderTimer = window.setTimeout(() => {
    showCommentsLoader.value = true
    loaderTimer = undefined
  }, 400)
})

function convertAvatarPath(path: string): string {
  return avatarPath(path)
}

function viewUserAvatar(): void {
  ImgViewer.view(convertAvatarPath(user.value.avatar))
}

function viewImageUrl(url: string): void {
  ImgViewer.view(url)
}

function userAction(
  action:
    | 'changeName'
    | 'changeAvatar'
    | 'changeEmail'
    | 'changePassword'
    | 'recoveryKey'
    | 'logout'
    | 'resetToken',
): void {
  if (!canManage.value) return
  runProfileAction(action)
}

function openAdmin(): void {
  if (!canManage.value || confirmedProfile.value?.role !== 'admin') return
  Popups.show('adminPanel')
}

function toUserComment(raw: UserCommentPage['items'][number]): UserComment {
  const date = new Date(raw.time * 1000)
  return {
    id: raw.id,
    ...(raw.number === undefined ? {} : { number: raw.number }),
    comment: raw.comment,
    time: raw.time,
    timeStr: `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
    images: raw.image ? raw.image.split(',') : [],
  }
}

function applyCommentPage(page: UserCommentPage, replace = false): void {
  const existing = new Map(comments.value.map((item) => [item.id, item]))
  const incoming = page.items.map(toUserComment)
  const next = replace ? [] : [...comments.value]
  for (const item of incoming) {
    const previous = existing.get(item.id)
    if (previous) {
      Object.assign(previous, item)
      if (replace) next.push(previous)
    } else if (!next.some((current) => current.id === item.id)) {
      next.push(item)
    }
  }
  comments.value = next
  nextCursor.value = page.hasMore ? page.nextCursor : null
  toEnd.value = !page.hasMore
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function getComments(refresh = false): Promise<void> {
  const generation = sessionGeneration
  const uid = user.value.id
  if (scrollPaused.value || !uid || (!refresh && toEnd.value)) return
  let cursor = refresh ? undefined : (nextCursor.value ?? undefined)
  let requestKey = refresh ? 'refresh' : String(cursor ?? 'first')
  if (
    pendingCursorRequests.has(requestKey) ||
    completedCursorRequests.has(requestKey)
  )
    return
  pendingCursorRequests.add(requestKey)
  scrollPaused.value = true
  loadingComments.value = true
  commentsError.value = false
  const firstPage = cursor === undefined
  let pageIndex = 0
  try {
    while (true) {
      const page =
        cursor === undefined
          ? await prefetchUserHomePage({
              viewerId: currentViewerId(),
              profileUserId: uid,
              signal: lifecycle.signal,
            })
          : await commentsApi.listUser(uid, cursor, lifecycle.signal)
      if (generation !== sessionGeneration || !lifecycle.isActive()) return
      applyCommentPage(page, refresh && pageIndex === 0)
      completedCursorRequests.add(requestKey)
      pendingCursorRequests.delete(requestKey)
      if (comments.value.length || !page.hasMore || page.nextCursor === null)
        break
      cursor = page.nextCursor
      requestKey = String(cursor)
      if (
        pendingCursorRequests.has(requestKey) ||
        completedCursorRequests.has(requestKey)
      )
        break
      pendingCursorRequests.add(requestKey)
      pageIndex += 1
    }
    if (firstPage && generation === sessionGeneration) {
      await nextTick()
      markPerformanceEvent('user-comments-first-page-ready', {
        cached: false,
        count: comments.value.length,
      })
    }
  } catch (error) {
    if (
      generation === sessionGeneration &&
      lifecycle.isActive() &&
      !isAbortError(error) &&
      !refresh
    )
      commentsError.value = true
  } finally {
    if (generation !== sessionGeneration) return
    scrollPaused.value = false
    loadingComments.value = false
    pendingCursorRequests.delete(requestKey)
  }
}

function startUserComments(): void {
  const uid = user.value.id
  if (!uid || startedUserId === uid) return
  startedUserId = uid
  const viewer = currentViewerId()
  const cached = getCachedUserHomePage(viewer, uid)
  if (cached) {
    applyCommentPage(cached, true)
    markPerformanceEvent('user-comments-first-page-ready', {
      cached: true,
      count: comments.value.length,
    })
    void getComments(true)
    return
  }
  void getComments()
}

async function markProfileReady(): Promise<void> {
  profileReady.value = true
  if (profileReadyMarked) return
  profileReadyMarked = true
  await nextTick()
  markPerformanceEvent('user-profile-ready', { id: user.value.id })
}

function resetForUser(profile: UserProfile): void {
  const previousUserId = user.value.id
  sessionGeneration += 1
  lifecycle.dispose()
  if (previousUserId && previousUserId !== profile.id)
    cancelUserHomePrefetch(previousUserId)
  lifecycle = createViewLifecycle()
  startedUserId = null
  pendingCursorRequests.clear()
  completedCursorRequests.clear()
  comments.value = []
  commentsError.value = false
  nextCursor.value = null
  toEnd.value = false
  scrollPaused.value = false
  loadingComments.value = false
  Object.assign(user.value, profile)
}

function replaceWithLogin(): void {
  lifecycle.dispose()
  showAuthHint.value = false
  if (props.popupId !== undefined) Popups.replace(props.popupId, 'loginPopup')
}

async function getUser(): Promise<void> {
  if (props.loadingAuth) {
    const profilePromise = authStore.ready()
    if (user.value.id) startUserComments()
    const profile = await profilePromise
    if (!lifecycle.isActive()) return
    if (authLoaderTimer !== undefined) {
      window.clearTimeout(authLoaderTimer)
      authLoaderTimer = undefined
    }
    showAuthHint.value = false
    if (!profile) {
      replaceWithLogin()
      return
    }
    if (user.value.id !== profile.id) resetForUser(profile)
    Object.assign(user.value, profile)
    confirmedProfile.value = profile
    showAction.value = true
    await markProfileReady()
    startUserComments()
    return
  }
  if (props.profile) {
    Object.assign(user.value, props.profile)
    confirmedProfile.value = props.profile
    showAction.value = props.profile.id === authStore.state.userId
    await markProfileReady()
    startUserComments()
    return
  }
  const response = await XHR.get<UserProfile[]>('user/find', { id: props.id })
  if (!lifecycle.isActive()) return
  const profile = Array.isArray(response) ? response[0] : response
  if (!profile) {
    FloatMsgs.show({
      type: 'warn',
      msg: `<span class="ui zh">找不到用户</span><span class="ui en">User not found</span> (ID: ${props.id ?? ''})`,
    })
    return
  }
  Object.assign(user.value, profile)
  confirmedProfile.value = profile
  showAction.value = profile.id === authStore.state.userId
  await markProfileReady()
  startUserComments()
}

function handleScroll(event: Event): void {
  if (scrollPaused.value) return
  const element = event.currentTarget as HTMLElement
  const distance =
    element.scrollHeight - element.clientHeight - element.scrollTop
  if (distance < 100) void getComments()
}

function gotoComment(index: number): void {
  const comment = comments.value[index]
  if (!comment) return
  const jump = comment.number
    ? commentsStore.gotoNumber(comment.number)
    : commentsStore.gotoId(comment.id)
  void jump.catch(() => undefined)
  Popups.close()
}

onMounted(() => {
  if (profileReady.value) void markProfileReady()
  void getUser()
})

onBeforeUnmount(() => {
  lifecycle.dispose()
  if (loaderTimer !== undefined) window.clearTimeout(loaderTimer)
  if (authLoaderTimer !== undefined) window.clearTimeout(authLoaderTimer)
})
</script>
