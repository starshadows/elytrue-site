<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, watch } from 'vue'
import Popups from './Popups'
import {
  avatarPath,
  initializeAuth,
  runProfileAction,
} from '../features/auth/auth-actions'
import { useAuth, type ProfileAction } from '../features/auth/useAuth'
import { markPerformanceEvent } from '../lib/performance'
import {
  profileHint,
  type OptimisticProfile,
} from '../features/auth/profile-hint'
import StableAvatar from './StableAvatar.vue'
import { prefetchUserHomePage } from '../features/comments/user-home-prefetch'

const auth = useAuth()
const displayProfile = computed(
  () =>
    auth.profile.value ??
    (auth.loginState.value === 'loading' ? profileHint.value : null),
)
const avatar = computed(() => avatarPath(displayProfile.value?.avatar))
const name = computed(() => displayProfile.value?.name ?? '')
const showNameSkeleton = computed(
  () => auth.loginState.value === 'loading' && !displayProfile.value,
)
const homeUrl = `${window.location.origin}${window.location.pathname}`
const optimisticProfile = computed<OptimisticProfile | null>(() => {
  const hint = profileHint.value
  return hint
    ? { userId: hint.userId, name: hint.name, avatar: hint.avatar }
    : null
})
let idleCallbackId: number | undefined
let idleFallbackId: number | undefined

function lowEndOrSaveData(): boolean {
  const browserNavigator = navigator as Navigator & {
    connection?: { saveData?: boolean }
    deviceMemory?: number
  }
  return (
    browserNavigator.connection?.saveData === true ||
    (browserNavigator.hardwareConcurrency > 0 &&
      browserNavigator.hardwareConcurrency <= 2) ||
    (browserNavigator.deviceMemory !== undefined &&
      browserNavigator.deviceMemory <= 2)
  )
}

function prefetchCurrentUserComments(): void {
  const profile = auth.profile.value
  if (!profile) return
  void prefetchUserHomePage({
    viewerId: profile.id,
    profileUserId: profile.id,
  }).catch(() => undefined)
}

function prefetchOnIntent(): void {
  prefetchCurrentUserComments()
}

function scheduleIdlePrefetch(profile: typeof auth.profile.value): void {
  if (!profile || lowEndOrSaveData()) return
  if (idleCallbackId !== undefined) {
    window.cancelIdleCallback(idleCallbackId)
    idleCallbackId = undefined
  }
  if (idleFallbackId !== undefined) window.clearTimeout(idleFallbackId)
  if (typeof window.requestIdleCallback === 'function') {
    idleCallbackId = window.requestIdleCallback(
      () => {
        idleCallbackId = undefined
        prefetchCurrentUserComments()
      },
      { timeout: 2_000 },
    )
  } else {
    idleFallbackId = window.setTimeout(() => {
      idleFallbackId = undefined
      prefetchCurrentUserComments()
    }, 0)
  }
}

watch(() => auth.profile.value, scheduleIdlePrefetch, { immediate: true })

async function openUser(): Promise<void> {
  if (Popups.popups.some((item) => item.name === 'userHome')) return
  if (auth.loginState.value === 'loading') {
    Popups.show('userHome', {
      loadingAuth: true,
      optimisticProfile: optimisticProfile.value ?? undefined,
    })
    void initializeAuth()
  } else if (auth.loggedIn.value) {
    Popups.show('userHome', { profile: auth.profile.value ?? undefined })
  } else {
    Popups.show('loginPopup')
  }
  await nextTick()
  markPerformanceEvent('user-popup-shell-open')
}

function action(value: ProfileAction): void {
  runProfileAction(value)
}

onBeforeUnmount(() => {
  if (idleCallbackId !== undefined) window.cancelIdleCallback(idleCallbackId)
  if (idleFallbackId !== undefined) window.clearTimeout(idleFallbackId)
})
</script>

<template>
  <div id="header">
    <div id="mainTitle">
      <a :href="homeUrl">
        <span style="color: #ff80c0">星花</span>
        <span style="color: #c074ff">札记</span>
      </a>
    </div>
    <br />
    <div
      class="mainTitleUnder"
      role="button"
      tabindex="0"
      @click="Popups.show('themeSelectorPopup')"
      @keydown.enter="Popups.show('themeSelectorPopup')"
      @keydown.space.prevent="Popups.show('themeSelectorPopup')"
    >
      <img class="musicPlayingIndicator" src="/res/music_note.svg" alt="" />
      <div id="themeIndicator">
        <div class="currentSong"></div>
        <span
          ><span class="ui zh">主题:</span
          ><span class="ui en">Theme:</span></span
        >
        <span id="currentTheme">
          <span id="themeTxt-default">
            <span class="ui zh">爱莉希雅</span><span class="ui en">Elysia</span>
          </span>
        </span>
      </div>
      <img src="/res/arrow_right.svg" alt="" />
    </div>
    <br />
    <div
      id="userInfo"
      :class="{ nologin: !auth.loggedIn.value }"
      role="button"
      tabindex="0"
      @click="openUser"
      @keydown.enter="openUser"
      @keydown.space.prevent="openUser"
      @pointerenter="prefetchOnIntent"
      @focusin="prefetchOnIntent"
    >
      <StableAvatar
        id="userInfoAvatar"
        :src="avatar"
        alt=""
        loading="eager"
        fetchpriority="high"
      />
      <span id="userInfoName">
        <span
          v-if="showNameSkeleton"
          class="userNameSkeleton"
          aria-label="正在确认登录状态"
        ></span>
        <template v-else-if="name">{{ name }}</template>
        <template v-else>
          <span class="ui zh">访客</span><span class="ui en">Anonymous</span>
        </template>
      </span>
      <div v-if="auth.loggedIn.value" id="my-dropdown" style="display: none">
        <div>
          <div @click.stop="action('changeName')">
            <span class="ui zh">修改昵称</span
            ><span class="ui en">Change nickname</span>
          </div>
          <div @click.stop="action('changeAvatar')">
            <span class="ui zh">修改头像</span
            ><span class="ui en">Change avatar</span>
          </div>
          <div @click.stop="action('changeEmail')">
            <span class="ui zh">修改邮箱</span
            ><span class="ui en">Change email</span>
          </div>
          <div @click.stop="action('showMe')">
            <span class="ui zh">我的留言</span
            ><span class="ui en">My sent messages</span>
          </div>
          <div @click.stop="action('logout')">
            <span class="ui zh">退出</span><span class="ui en">Logout</span>
          </div>
        </div>
      </div>
    </div>
  </div>
  <footer id="siteFooter">
    <a
      href="https://beian.miit.gov.cn/"
      target="_blank"
      rel="noopener noreferrer"
      >赣ICP备2026015414号-1</a
    >
  </footer>
</template>
