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
          <span>
            <span class="ui zh">注册时间: </span
            ><span class="ui en">Joined </span>
            {{ new Date((user.create_time ?? 0) * 1000).toLocaleDateString() }}
          </span>
        </div>
      </div>
    </div>
    <div v-if="showAuthHint" class="userAuthLoadingHint">
      <span class="ui zh">正在确认登录状态…</span>
      <span class="ui en">Checking sign-in status…</span>
    </div>
    <div v-if="showAction" class="useraction">
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
      v-if="showCommentsLoader && !showAuthHint"
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
      :key="`${item.source ?? ''}-${item.id}`"
      class="userCommentItem"
    >
      <p>
        {{ item.timeStr
        }}<span>#{{ item.number ?? item.displayId ?? item.id }}</span>
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
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { avatarPath, runProfileAction } from '../../features/auth/auth-actions'
import { authStore, type UserProfile } from '../../features/auth/auth-store'
import {
  cacheUserCommentPage,
  commentsApi,
  getCachedUserCommentPage,
} from '../../features/comments/comments-api'
import type { UserCommentPage } from '../../features/comments/comment-types'
import { commentsStore } from '../../features/comments/comments-store'
import XHR from '../../net/xhr'
import FloatMsgs from '../FloatMsgs'
import ImgViewer from '../ImgViewer'
import Popups from './index'
import { markPerformanceEvent } from '../../lib/performance'
import { createViewLifecycle } from '../../features/comments/user-home-lifecycle'
import StableAvatar from '../StableAvatar.vue'

interface UserComment {
  id: number
  number?: number
  displayId?: number
  source?: string
  time: number
  timeStr?: string
  comment: string
  image?: string
  images: string[]
}

const props = defineProps<{
  id?: string
  name?: string
  avatar?: string
  profile?: UserProfile
  loadingAuth?: boolean
  popupClosing?: boolean
  popupId?: number
}>()

const user = ref<UserProfile>(
  props.profile ?? {
    id: props.id ?? '',
    name: props.name ?? '',
    avatar: props.avatar ?? '',
    create_time: 0,
  },
)
const showAction = ref(Boolean(props.profile))
const profileReady = ref(Boolean(props.profile || (props.id && props.name)))
const showAuthHint = ref(false)
const comments = ref<UserComment[]>([])
const scrollPaused = ref(false)
const loadingComments = ref(false)
const showCommentsLoader = ref(false)
const commentsError = ref(false)
const toEnd = ref(false)
const nextCursor = ref<number | string | null>(null)
let loaderTimer: number | undefined
let authLoaderTimer: number | undefined
const lifecycle = createViewLifecycle()
let profileReadyMarked = false
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

function userCommentCacheKey(): string {
  return `${authStore.state.userId ?? 'anonymous'}:${user.value.id}`
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
  if (!loading || showAuthHint.value) {
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
  runProfileAction(action)
}

function openAdmin(): void {
  Popups.show('adminPanel')
}

function applyCommentPage(page: UserCommentPage, replace = false): void {
  if (replace) comments.value = []
  for (const raw of page.items) {
    if (comments.value.some((item) => item.id === raw.id)) continue
    const date = new Date(raw.time * 1000)
    comments.value.push({
      id: raw.id,
      number: raw.number,
      comment: raw.comment,
      image: raw.image,
      time: raw.time,
      timeStr: `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
      images: raw.image ? raw.image.split(',') : [],
    })
  }
  nextCursor.value = page.hasMore ? page.nextCursor : null
  toEnd.value = !page.hasMore
}

async function getComments(refresh = false): Promise<void> {
  if (scrollPaused.value || !user.value.id || (!refresh && toEnd.value)) return
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
  let pageToCache: UserCommentPage | null = null
  try {
    while (true) {
      const page = await commentsApi.listUser(user.value.id, cursor)
      if (!lifecycle.isActive()) return
      applyCommentPage(page, refresh && pageIndex === 0)
      pageToCache = page
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
    if (firstPage) {
      if (pageToCache) cacheUserCommentPage(userCommentCacheKey(), pageToCache)
      await nextTick()
      markPerformanceEvent('user-comments-first-page-ready', {
        cached: false,
        count: comments.value.length,
      })
    }
  } catch {
    if (!refresh) commentsError.value = true
  } finally {
    scrollPaused.value = false
    loadingComments.value = false
    pendingCursorRequests.delete(requestKey)
  }
}

function startUserComments(): void {
  const cached = getCachedUserCommentPage(userCommentCacheKey())
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

async function getUser(): Promise<void> {
  if (props.loadingAuth) {
    const profile = await authStore.ready()
    if (!lifecycle.isActive()) return
    if (authLoaderTimer !== undefined) {
      window.clearTimeout(authLoaderTimer)
      authLoaderTimer = undefined
    }
    showAuthHint.value = false
    if (!profile) {
      if (props.popupId !== undefined)
        Popups.replace(props.popupId, 'loginPopup')
      return
    }
    user.value = profile
    showAction.value = true
    await markProfileReady()
    startUserComments()
    return
  }
  if (props.profile) {
    user.value = props.profile
    showAction.value = true
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
  user.value = profile
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
