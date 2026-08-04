<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import CommentCard from './CommentCard.vue'
import CommentEditor from './CommentEditor.vue'
import FloatMsgs from './FloatMsgs'
import Popups from './Popups'
import TimelinePanel from './TimelinePanel.vue'
import ToolsPanel from './ToolsPanel.vue'
import { commentsStore } from '../features/comments/comments-store'
import Settings from '../settings'
import { getConfig } from '../settings/config'
import type { CommentRecord } from '../features/comments/comment-types'
import { useAuth } from '../features/auth/useAuth'
import {
  finishPerformanceMark,
  markPerformanceEvent,
  startPerformanceMark,
} from '../lib/performance'

const emit = defineEmits<{ fullscreen: []; install: [] }>()
const auth = useAuth()
const container = useTemplateRef<HTMLDivElement>('container')
const panel = useTemplateRef<HTMLDivElement>('panel')
const newestSentinel = useTemplateRef<HTMLDivElement>('newestSentinel')
const oldestSentinel = useTemplateRef<HTMLDivElement>('oldestSentinel')
const editorOpen = ref(false)
const replyNumber = ref<number>()
type PanelMode = 'auto' | 'forced-up' | 'forced-down'
const panelMode = ref<PanelMode>('auto')
const pinnedHidden = computed(() => Settings.pinnedHidden)
const initialRequestSettled = ref(false)
const initialAnimationStarted = ref(false)
let firstCommentAnimationRecorded = false
let initialPerformanceFinished = false
let scrollPaused = false
let pauseTimer: number | undefined
let paginationObserver: IntersectionObserver | undefined
let bodyObserver: MutationObserver | undefined
let pointerInside = false
let previousOverscroll: { document: string; body: string } | undefined

function setOverscrollContainment(enabled: boolean): void {
  if (enabled) {
    if (!previousOverscroll) {
      previousOverscroll = {
        document: document.documentElement.style.overscrollBehavior,
        body: document.body.style.overscrollBehavior,
      }
    }
    document.documentElement.style.overscrollBehavior = 'contain'
    document.body.style.overscrollBehavior = 'contain'
    return
  }
  if (!previousOverscroll) return
  document.documentElement.style.overscrollBehavior =
    previousOverscroll.document
  document.body.style.overscrollBehavior = previousOverscroll.body
  previousOverscroll = undefined
}

function forceLowerPanelUp(): void {
  panelMode.value = 'forced-up'
  setOverscrollContainment(true)
}

function forceLowerPanelDown(): void {
  panelMode.value = pointerInside ? 'forced-down' : 'auto'
  setOverscrollContainment(false)
  document.getElementById('msgText')?.blur()
}

function handlePanelPointerEnter(event: PointerEvent): void {
  pointerInside = true
  if (panelMode.value === 'forced-down' && event.pointerType !== 'mouse') {
    panelMode.value = 'auto'
  }
}

function handlePanelPointerLeave(): void {
  pointerInside = false
  if (panelMode.value === 'forced-down') panelMode.value = 'auto'
}

function handlePanelPointerDown(event: PointerEvent): void {
  if (panelMode.value === 'forced-down' && event.pointerType !== 'mouse') {
    panelMode.value = 'auto'
  }
}

function handleDocumentPointerMove(event: PointerEvent): void {
  if (
    panelMode.value === 'forced-down' &&
    panel.value &&
    !event.composedPath().includes(panel.value)
  ) {
    pointerInside = false
    panelMode.value = 'auto'
  }
}

function pauseScroll(milliseconds: number): void {
  scrollPaused = true
  if (pauseTimer !== undefined) window.clearTimeout(pauseTimer)
  pauseTimer = window.setTimeout(() => (scrollPaused = false), milliseconds)
}

function seek(direction: -1 | 1): void {
  const element = container.value
  const item = element?.querySelector<HTMLElement>('.commentItem')
  if (!element || !item) return
  const width = item.getBoundingClientRect().width + 20
  element.scrollTo({
    left: element.scrollLeft + direction * width,
    behavior: 'smooth',
  })
}

function currentItem(): HTMLElement | undefined {
  const element = container.value
  if (!element) return undefined
  const items = Array.from(
    element.querySelectorAll<HTMLElement>('.commentItem'),
  )
  if (!items.length) return undefined
  const vertical = document.body.classList.contains('fullscreen')
  const range = vertical
    ? element.scrollHeight - element.clientHeight
    : element.scrollWidth - element.clientWidth
  const offset = vertical ? element.scrollTop : element.scrollLeft
  const index = Math.min(
    items.length - 1,
    Math.max(
      0,
      Math.round((range > 0 ? offset / range : 0) * (items.length - 1)),
    ),
  )
  return items[index]
}

function updateVisibleTime(): void {
  const timestamp = Number(currentItem()?.dataset.timestamp)
  commentsStore.setCurrentVisibleTime(
    Number.isFinite(timestamp) ? timestamp : null,
  )
}

async function loadNewer(): Promise<void> {
  const element = container.value
  const anchor = element?.querySelector<HTMLElement>('.commentItem')
  const before = anchor?.getBoundingClientRect()
  await commentsStore
    .loadNewer(document.body.classList.contains('fullscreen') ? 18 : 10)
    .catch(() => {
      FloatMsgs.show({
        type: 'error',
        msg: '<span class="ui zh">加载新留言失败</span><span class="ui en">Failed to load newer messages</span>',
      })
    })
  await nextTick()
  if (element && anchor && before) {
    const after = anchor.getBoundingClientRect()
    if (document.body.classList.contains('fullscreen'))
      element.scrollTop += after.top - before.top
    else element.scrollLeft += after.left - before.left
  }
}

async function loadOlder(): Promise<void> {
  await commentsStore.loadOlder().catch(() => {
    FloatMsgs.show({
      type: 'error',
      msg: '<span class="ui zh">加载历史留言失败</span><span class="ui en">Failed to load older messages</span>',
    })
  })
}

function checkNewest(): void {
  if (
    commentsStore.state.initialError ||
    commentsStore.state.jumping ||
    commentsStore.state.loadingInitial ||
    commentsStore.state.loadingNewer ||
    commentsStore.state.reachedNewest
  )
    return
  void loadNewer()
}

function checkOldest(): void {
  if (
    commentsStore.state.initialError ||
    commentsStore.state.jumping ||
    commentsStore.state.loadingInitial ||
    commentsStore.state.loadingOlder ||
    commentsStore.state.reachedOldest
  )
    return
  void loadOlder()
}

function setupPaginationObserver(): void {
  if (paginationObserver) return
  paginationObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        if (entry.target === newestSentinel.value) checkNewest()
        else if (entry.target === oldestSentinel.value) checkOldest()
      }
    },
    {
      root: container.value,
      threshold: 0,
    },
  )
  if (newestSentinel.value) paginationObserver.observe(newestSentinel.value)
  if (oldestSentinel.value) paginationObserver.observe(oldestSentinel.value)
}

function disposePaginationObserver(): void {
  paginationObserver?.disconnect()
  paginationObserver = undefined
}

function sentinelInView(
  element: HTMLDivElement | null | undefined,
  rootElement: HTMLDivElement | null,
): boolean {
  if (!element || !rootElement) return false
  const target = element.getBoundingClientRect()
  const root = rootElement.getBoundingClientRect()
  const pad = 8
  const vertical = document.body.classList.contains('fullscreen')
  return vertical
    ? target.bottom > root.top + pad && target.top < root.bottom - pad
    : target.right > root.left + pad && target.left < root.right - pad
}

function requestPaginationCheck(): void {
  void nextTick(() => {
    // 布局变化(分页追加/隐藏置顶/全屏切换)后按当前几何位置复核,
    // 避免 sentinel 已被推出视口却仍触发请求
    if (sentinelInView(newestSentinel.value, container.value)) checkNewest()
    if (sentinelInView(oldestSentinel.value, container.value)) checkOldest()
  })
}

function handleScroll(): void {
  if (scrollPaused || !container.value) return
  updateVisibleTime()
}

watch(
  () =>
    [
      commentsStore.state.jumping,
      commentsStore.state.jumpNumber,
      commentsStore.state.loadingInitial,
      commentsStore.state.items,
    ] as const,
  async ([jumping, number, loadingInitial]) => {
    if (!jumping || number === null || loadingInitial) return
    await nextTick()
    if (
      !commentsStore.state.jumping ||
      commentsStore.state.jumpNumber !== number ||
      commentsStore.state.loadingInitial
    )
      return
    container.value
      ?.querySelector<HTMLElement>(`[data-number="${number}"]`)
      ?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'center',
      })
    commentsStore.finishJump()
  },
  { flush: 'post' },
)

watch(
  () => commentsStore.state.items,
  () => requestPaginationCheck(),
  { flush: 'post' },
)

watch(
  () => commentsStore.state.loadingInitial,
  async (loading, previousLoading) => {
    if (!previousLoading || loading || initialPerformanceFinished) return
    initialPerformanceFinished = true
    initialRequestSettled.value = true
    await nextTick()
    updateVisibleTime()
    markPerformanceEvent('initial-comment-dom-ready', {
      count: commentsStore.state.items.length,
    })
    finishPerformanceMark('comments-initial')
  },
  { flush: 'post' },
)

function handleWheel(event: WheelEvent): void {
  if (document.body.classList.contains('fullscreen') || event.deltaX) return
  const target = event.target
  if (
    target instanceof HTMLElement &&
    (target.closest('.comment')?.scrollHeight ?? 0) >
      (target.closest('.comment')?.clientHeight ?? 0)
  )
    return
  if (Math.abs(event.deltaY) >= 10) seek(event.deltaY > 0 ? 1 : -1)
}

function openEditor(number?: number): void {
  replyNumber.value = number
  editorOpen.value = true
  forceLowerPanelUp()
}

function closeEditor(): void {
  editorOpen.value = false
  replyNumber.value = undefined
  document.body.classList.remove('touchKeyboardShowing')
  forceLowerPanelDown()
}

function handleSent(comment: CommentRecord): void {
  commentsStore.insertCreatedComment(comment)
}

function retryInitialLoad(): void {
  void commentsStore
    .initialize()
    .then(() => {
      if (auth.loggedIn.value) return commentsStore.hydrateViewerLikes()
    })
    .catch(() => undefined)
}

function handleInitialAnimationStart(event: AnimationEvent): void {
  if (
    event.target !== event.currentTarget ||
    event.animationName !== 'commentBoxAppear'
  )
    return
  if (firstCommentAnimationRecorded) return
  firstCommentAnimationRecorded = true
  markPerformanceEvent('first-comment-animation-start')
  initialAnimationStarted.value = true
}

function hidePinned(): void {
  Settings.pinnedHidden = true
  FloatMsgs.show({
    type: 'success',
    persist: true,
    msg: '<span class="ui zh">隐藏成功。可在【工具】→【显示设置】中重新打开</span><span class="ui en">Hidden. Can be displayed again via [Tools] → [Display settings]</span>',
  })
}

function onSeek(event: Event): void {
  if (
    event instanceof CustomEvent &&
    (event.detail === -1 || event.detail === 1)
  )
    seek(event.detail)
}

function onOpenEditor(): void {
  openEditor()
}

onMounted(() => {
  startPerformanceMark('comments-initial')
  container.value?.addEventListener('scroll', handleScroll)
  container.value?.addEventListener('wheel', handleWheel)
  document.addEventListener('elytrue:seek-comment', onSeek)
  document.addEventListener('elytrue:open-comment-editor', onOpenEditor)
  document.addEventListener('pointermove', handleDocumentPointerMove)
  setupPaginationObserver()
  bodyObserver = new MutationObserver(() => requestPaginationCheck())
  bodyObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })
  if (getConfig('showTimeline') === 'false')
    document
      .getElementById('timelineContainer')
      ?.style.setProperty('display', 'none')
})

onBeforeUnmount(() => {
  container.value?.removeEventListener('scroll', handleScroll)
  container.value?.removeEventListener('wheel', handleWheel)
  document.removeEventListener('elytrue:seek-comment', onSeek)
  document.removeEventListener('elytrue:open-comment-editor', onOpenEditor)
  document.removeEventListener('pointermove', handleDocumentPointerMove)
  if (pauseTimer !== undefined) window.clearTimeout(pauseTimer)
  disposePaginationObserver()
  bodyObserver?.disconnect()
  bodyObserver = undefined
  panelMode.value = 'auto'
  setOverscrollContainment(false)
  document.body.classList.remove('touchKeyboardShowing')
})

defineExpose({ forceLowerPanelDown, forceLowerPanelUp, pauseScroll })
</script>

<template>
  <div
    id="lowerPanel"
    ref="panel"
    :class="{
      lowerPanelUp: panelMode === 'forced-up',
      lowerPanelDown: panelMode === 'forced-down',
    }"
    @pointerenter="handlePanelPointerEnter"
    @pointerleave="handlePanelPointerLeave"
    @pointerdown="handlePanelPointerDown"
  >
    <div class="tooltip">
      <span class="ui zh">今日留言: </span
      ><span class="ui en">Messages today: </span
      ><span id="todayCommentCount">{{ commentsStore.state.todayCount }}</span>
    </div>
    <div id="comments" ref="container" class="noscrollbar">
      <div
        ref="newestSentinel"
        class="paginationSentinel"
        data-direction="newer"
        aria-hidden="true"
      ></div>
      <div
        v-if="!pinnedHidden"
        id="topComment"
        class="commentBox"
        :data-initial-request-settled="initialRequestSettled"
        :data-initial-animation-started="initialAnimationStarted"
      >
        <img class="bg" src="/assets/elytrue-20260724/bg/portrait1.webp" />
        <div class="bgcover"></div>
        <img class="avatar" src="/res/favicon-320.png" />
        <div class="sender">
          <span class="ui zh">星花札记</span
          ><span class="ui en">Starflower Notes</span>
        </div>
        <div class="id">
          <span class="ui zh">#置顶</span><span class="ui en">#Pinned</span>
        </div>
        <div class="comment">
          <div class="ui zh pinnedNoticeCopy">
            欢迎来到
            <strong style="text-decoration: underline">星花札记</strong
            >。<br />这里是以<strong style="color: #ffbbdd">爱莉希雅</strong
            >为主题的非商业个人同人网站。<br /><br />留言板用于记录祝愿、感想与日常，也可以分享与角色相关的作品和故事。<br /><br /><b
              >※ 请友善交流，共同守护这座花园 ※</b
            ><br />请勿发布广告、骚扰、违法、侵权或不适宜内容。<br /><br />游客可以浏览；注册后可留言、回复、点赞、举报和上传图片。<br /><br /><a
              href="#"
              @click.prevent="Popups.show('getImgPopup')"
              >→ 点击查看图片与画师致谢 ←</a
            >
          </div>
          <div class="ui en pinnedNoticeCopy">
            Welcome to
            <strong style="text-decoration: underline">Starflower Notes</strong
            >, a non-commercial personal fan site themed around
            <strong style="color: #ffbbdd">Elysia</strong>.<br /><br />Visitors
            can browse. Registered users can post, reply, like, report and
            upload images.<br /><br /><a
              href="#"
              @click.prevent="Popups.show('getImgPopup')"
              >→ View image sources and artist credits ←</a
            >
          </div>
        </div>
        <button
          type="button"
          class="time semanticButton"
          style="
            text-decoration: underline;
            font-size: 1rem;
            right: 0;
            left: initial;
            cursor: pointer;
          "
          @click="hidePinned"
        >
          <span class="ui zh">隐藏 ×</span><span class="ui en">Hide ×</span>
        </button>
      </div>
      <CommentEditor
        v-if="editorOpen"
        :reply-number="replyNumber"
        @close="closeEditor"
        @focus="forceLowerPanelUp"
        @sent="handleSent"
      />
      <div
        v-for="index in 3"
        v-if="
          commentsStore.state.loadingInitial &&
          !commentsStore.state.items.length &&
          !commentsStore.state.initialError
        "
        :key="`comment-skeleton-${index}`"
        class="commentBox commentSkeleton"
        aria-hidden="true"
      >
        <i class="commentSkeletonAvatar"></i>
        <i class="commentSkeletonName"></i>
        <i class="commentSkeletonLine"></i>
        <i class="commentSkeletonLine short"></i>
      </div>
      <CommentCard
        v-for="(record, index) in commentsStore.state.items"
        :key="record.id"
        :record="record"
        :eager="index < 4"
        @animationstart="index === 0 && handleInitialAnimationStart($event)"
        @lift="forceLowerPanelUp"
        @reply="openEditor"
      />
      <div
        v-if="
          commentsStore.state.initialError && !commentsStore.state.items.length
        "
        class="commentBox commentsLoadError"
      >
        <span class="ui zh">留言加载失败</span>
        <span class="ui en">Failed to load messages</span>
        <button type="button" @click="retryInitialLoad">
          <span class="ui zh">重新加载</span><span class="ui en">Retry</span>
        </button>
      </div>
      <div
        ref="oldestSentinel"
        class="paginationSentinel"
        data-direction="older"
        aria-hidden="true"
      ></div>
    </div>
    <TimelinePanel />
    <button
      type="button"
      class="commentSeekArrow semanticButton"
      style="left: 2vw"
      aria-label="上一页留言"
      @click="seek(-1)"
    >
      <img src="/res/arrow_left.svg" alt="" />
    </button>
    <button
      type="button"
      class="commentSeekArrow semanticButton"
      style="right: 2vw"
      aria-label="下一页留言"
      @click="seek(1)"
    >
      <img src="/res/arrow_right.svg" alt="" />
      <div id="mouseScrollTooltip" class="tooltip">
        <span class="ui zh">用鼠标滚轮也可滚动</span
        ><span class="ui en">Scrollable with wheel</span>
      </div>
    </button>
    <ToolsPanel
      @new-comment="openEditor()"
      @fullscreen="emit('fullscreen')"
      @install="emit('install')"
    />
  </div>
</template>
