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
import LegalLinks from './LegalLinks.vue'
import { commentsStore } from '../features/comments/comments-store'
import { commentBackground } from '../features/comments/comment-backgrounds'
import Settings from '../settings'
import type { CommentRecord } from '../features/comments/comment-types'
import { useAuth } from '../features/auth/useAuth'
import StableAvatar from './StableAvatar.vue'
import {
  createCommentNavigationController,
  type CommentNavigationController,
} from '../features/comments/comment-navigation-controller'
import {
  finishPerformanceMark,
  markPerformanceEvent,
  startPerformanceMark,
} from '../lib/performance'

const emit = defineEmits<{ fullscreen: []; install: [] }>()
const auth = useAuth()
const pinnedBackground = commentBackground('pinned')
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
const commentsEntrancePlaying = ref(
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !document.body.classList.contains('lowend'),
)
const canSeekLeft = ref(false)
const canSeekRight = ref(false)
const enteringCommentIds = ref(new Set<number>())
let commentsEntranceRecorded = false
let initialPerformanceFinished = false
let initialDomRecorded = false
let scrollPaused = false
let pauseTimer: number | undefined
let paginationObserver: IntersectionObserver | undefined
let bodyObserver: MutationObserver | undefined
let navigationController: CommentNavigationController | undefined
let navigationResizeObserver: ResizeObserver | undefined
let previousOverscroll: { document: string; body: string } | undefined
type TouchGestureIntent =
  'pending' | 'native' | 'panel-up' | 'panel-down' | 'comment-drag'
interface PanelTouchGesture {
  readonly identifier: number
  readonly startX: number
  readonly startY: number
  readonly startTime: number
  readonly startedExpanded: boolean
  readonly scrollTarget?: HTMLElement
  readonly canDragComments: boolean
  readonly startScrollLeft: number
  intent: TouchGestureIntent
  horizontalVelocity: number
  lastX: number
  lastY: number
  lastTime: number
}
const TOUCH_DIRECTION_LOCK_PX = 12
const TOUCH_EXPAND_PX = 20
const TOUCH_ACTIVATION_ZONE_PX = 120
const TOUCH_COLLAPSE_DISTANCE_RATIO = 0.08
const TOUCH_COLLAPSE_VELOCITY_PER_MS = 0.00035
const TOUCH_PROJECTION_TIME_MS = 240
const TOUCH_MAX_SCROLL_VELOCITY_PX_PER_MS = 3.5
const TOUCH_VELOCITY_SAMPLE_WEIGHT = 0.75
const TOUCH_VELOCITY_STALE_MS = 80
let touchGesture: PanelTouchGesture | undefined

async function recordInitialCommentDomReady(): Promise<void> {
  if (initialDomRecorded || commentsStore.state.items.length === 0) return
  await nextTick()
  if (!container.value?.querySelector('.commentItem')) return
  initialDomRecorded = true
  markPerformanceEvent('initial-comment-dom-ready', {
    count: commentsStore.state.items.length,
  })
}

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
  panelMode.value = 'forced-down'
  setOverscrollContainment(false)
  document.getElementById('msgText')?.blur()
}

function handlePanelPointerLeave(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return
  if (panelMode.value === 'forced-down') panelMode.value = 'auto'
}

function handleDocumentPointerMove(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return
  if (
    panelMode.value === 'forced-down' &&
    panel.value &&
    !event.composedPath().includes(panel.value)
  ) {
    panelMode.value = 'auto'
  }
}

function isTouchEditorTarget(path: EventTarget[]): boolean {
  return path.some(
    (target) =>
      target instanceof HTMLElement &&
      target.matches(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .CodeMirror',
      ),
  )
}

function isTouchProtectedTarget(path: EventTarget[]): boolean {
  return path.some(
    (target) =>
      target instanceof HTMLElement &&
      target.matches(
        '#popups, #popups *, .img-viewer-overlay, .img-viewer-overlay *, #videoPlayerLayer, #videoPlayerLayer *, input, textarea, select, button, a, label, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], .monaco-editor, .CodeMirror',
      ),
  )
}

function findTouchScrollTarget(path: EventTarget[]): HTMLElement | undefined {
  return path.find((target): target is HTMLElement => {
    if (!(target instanceof HTMLElement)) return false
    if (target === container.value) return false
    const style = window.getComputedStyle(target)
    return (
      /(auto|scroll)/.test(style.overflowY) &&
      target.scrollHeight > target.clientHeight + 1
    )
  })
}

function canScrollVertically(target: HTMLElement | undefined, deltaY: number) {
  if (!target) return false
  const maximum = target.scrollHeight - target.clientHeight
  return deltaY < 0 ? target.scrollTop < maximum - 1 : target.scrollTop > 1
}

function findTouch(touches: TouchList, identifier: number): Touch | undefined {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index)
    if (touch?.identifier === identifier) return touch
  }
  return undefined
}

function clearTouchPanelTransform(): void {
  if (!panel.value) return
  panel.value.style.removeProperty('transition')
  panel.value.style.removeProperty('transform')
}

function settleCancelledTouchGesture(): void {
  const gesture = touchGesture
  if (!gesture) return
  if (gesture.intent === 'comment-drag' && container.value) {
    navigationController?.settleToProjectedOffset(container.value.scrollLeft)
  }
  clearTouchPanelTransform()
  touchGesture = undefined
}

function handlePanelTouchStart(event: TouchEvent): void {
  settleCancelledTouchGesture()
  if (
    event.touches.length !== 1 ||
    document.body.classList.contains('fullscreen')
  )
    return
  const touch = event.touches.item(0)
  if (!touch) return
  const path = event.composedPath()
  const panelElement = panel.value
  if (!panelElement || Popups.isOpen() || isTouchProtectedTarget(path)) return
  const insidePanel = path.includes(panelElement)
  const panelTop = panelElement.getBoundingClientRect().top
  const insideActivationZone =
    touch.clientY < panelTop &&
    touch.clientY >= panelTop - TOUCH_ACTIVATION_ZONE_PX
  if (!insidePanel && !insideActivationZone) return
  const detectedScrollTarget = findTouchScrollTarget(path)
  const scrollTarget = detectedScrollTarget?.matches('.comment')
    ? detectedScrollTarget
    : undefined
  const commentsElement = container.value
  const canDragComments = Boolean(
    commentsElement &&
    path.includes(commentsElement) &&
    path.some(
      (target) =>
        target instanceof HTMLElement &&
        target.classList.contains('commentBox'),
    ),
  )
  touchGesture = {
    identifier: touch.identifier,
    startX: touch.clientX,
    startY: touch.clientY,
    startTime: event.timeStamp,
    startedExpanded: panelMode.value === 'forced-up',
    scrollTarget,
    canDragComments,
    startScrollLeft: commentsElement?.scrollLeft ?? 0,
    intent: isTouchEditorTarget(path) ? 'native' : 'pending',
    horizontalVelocity: 0,
    lastX: touch.clientX,
    lastY: touch.clientY,
    lastTime: event.timeStamp,
  }
}

function handlePanelTouchMove(event: TouchEvent): void {
  const gesture = touchGesture
  if (!gesture || gesture.intent === 'native') return
  const touch = findTouch(event.touches, gesture.identifier)
  if (!touch) return
  const deltaX = touch.clientX - gesture.startX
  const deltaY = touch.clientY - gesture.startY
  const sampleElapsed = Math.max(1, event.timeStamp - gesture.lastTime)
  const sampleVelocity = Math.min(
    TOUCH_MAX_SCROLL_VELOCITY_PX_PER_MS,
    Math.max(
      -TOUCH_MAX_SCROLL_VELOCITY_PX_PER_MS,
      (gesture.lastX - touch.clientX) / sampleElapsed,
    ),
  )
  gesture.lastX = touch.clientX
  gesture.lastY = touch.clientY
  gesture.lastTime = event.timeStamp

  if (gesture.intent === 'pending') {
    if (
      Math.abs(deltaX) < TOUCH_DIRECTION_LOCK_PX &&
      Math.abs(deltaY) < TOUCH_DIRECTION_LOCK_PX
    )
      return
    if (Math.abs(deltaX) >= Math.abs(deltaY)) {
      if (!gesture.canDragComments) {
        gesture.intent = 'native'
        return
      }
      gesture.intent = 'comment-drag'
      navigationController?.cancel(false)
    } else if (!gesture.startedExpanded && deltaY <= -TOUCH_EXPAND_PX) {
      gesture.intent = 'panel-up'
      forceLowerPanelUp()
    } else if (gesture.startedExpanded && deltaY > 0) {
      if (deltaY < TOUCH_EXPAND_PX) return
      if (!canScrollVertically(gesture.scrollTarget, deltaY)) {
        gesture.intent = 'panel-down'
      } else {
        gesture.intent = 'native'
        return
      }
    } else if (gesture.startedExpanded || deltaY > 0) {
      gesture.intent = 'native'
      return
    } else {
      return
    }
  }

  if (gesture.intent === 'comment-drag') {
    gesture.horizontalVelocity =
      gesture.horizontalVelocity * (1 - TOUCH_VELOCITY_SAMPLE_WEIGHT) +
      sampleVelocity * TOUCH_VELOCITY_SAMPLE_WEIGHT
    navigationController?.dragToOffset(gesture.startScrollLeft - deltaX)
    event.preventDefault()
    return
  }

  if (gesture.intent === 'panel-down' && panel.value) {
    panel.value.style.transition = 'none'
    panel.value.style.transform = `translateY(${Math.max(0, deltaY)}px)`
  }
  if (gesture.intent === 'panel-up' || gesture.intent === 'panel-down') {
    event.preventDefault()
  }
}

function finishPanelTouch(event: TouchEvent, cancelled = false): void {
  const gesture = touchGesture
  if (!gesture) return
  const touch = findTouch(event.changedTouches, gesture.identifier)
  if (touch) {
    if (gesture.intent === 'comment-drag' && touch.clientX !== gesture.lastX) {
      const elapsed = Math.max(1, event.timeStamp - gesture.lastTime)
      const sampleVelocity = Math.min(
        TOUCH_MAX_SCROLL_VELOCITY_PX_PER_MS,
        Math.max(
          -TOUCH_MAX_SCROLL_VELOCITY_PX_PER_MS,
          (gesture.lastX - touch.clientX) / elapsed,
        ),
      )
      gesture.horizontalVelocity =
        gesture.horizontalVelocity * (1 - TOUCH_VELOCITY_SAMPLE_WEIGHT) +
        sampleVelocity * TOUCH_VELOCITY_SAMPLE_WEIGHT
      gesture.lastX = touch.clientX
      gesture.lastTime = event.timeStamp
      navigationController?.dragToOffset(
        gesture.startScrollLeft - (touch.clientX - gesture.startX),
      )
    }
    gesture.lastY = touch.clientY
  }
  if (gesture.intent === 'comment-drag' && container.value) {
    const velocityIsFresh =
      event.timeStamp - gesture.lastTime <= TOUCH_VELOCITY_STALE_MS
    const projectedOffset = cancelled
      ? container.value.scrollLeft
      : container.value.scrollLeft +
        (velocityIsFresh ? gesture.horizontalVelocity : 0) *
          TOUCH_PROJECTION_TIME_MS
    navigationController?.settleToProjectedOffset(projectedOffset)
  } else if (gesture.intent === 'panel-down') {
    clearTouchPanelTransform()
    const viewportHeight = Math.max(1, window.innerHeight)
    const distanceRatio =
      Math.max(0, gesture.lastY - gesture.startY) / viewportHeight
    const elapsed = Math.max(1, gesture.lastTime - gesture.startTime)
    const velocity = distanceRatio / elapsed
    if (
      !cancelled &&
      (distanceRatio >= TOUCH_COLLAPSE_DISTANCE_RATIO ||
        velocity >= TOUCH_COLLAPSE_VELOCITY_PER_MS)
    ) {
      forceLowerPanelDown()
    } else {
      forceLowerPanelUp()
    }
  }
  touchGesture = undefined
}

function handlePanelTouchEnd(event: TouchEvent): void {
  finishPanelTouch(event)
}

function handlePanelTouchCancel(event: TouchEvent): void {
  finishPanelTouch(event, true)
}

function pauseScroll(milliseconds: number): void {
  scrollPaused = true
  if (pauseTimer !== undefined) window.clearTimeout(pauseTimer)
  pauseTimer = window.setTimeout(() => (scrollPaused = false), milliseconds)
}

function seek(direction: -1 | 1): void {
  if (document.body.classList.contains('fullscreen')) return
  navigationController?.seekByItems(direction)
}

function updateSeekAvailability(): void {
  const element = container.value
  if (!element || document.body.classList.contains('fullscreen')) {
    canSeekLeft.value = false
    canSeekRight.value = false
    return
  }
  const maxScrollLeft = element.scrollWidth - element.clientWidth
  canSeekLeft.value = element.scrollLeft > 1
  canSeekRight.value = element.scrollLeft < maxScrollLeft - 1
}

function currentItem(): HTMLElement | undefined {
  const element = container.value
  if (!element) return undefined
  const items = Array.from(
    element.querySelectorAll<HTMLElement>('.commentItem'),
  ).filter((item) => window.getComputedStyle(item).display !== 'none')
  if (!items.length) return undefined
  const vertical = document.body.classList.contains('fullscreen')
  const containerRect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  const anchor = vertical
    ? containerRect.top +
      element.clientTop +
      (parseFloat(style.paddingTop) || 0)
    : containerRect.left +
      element.clientLeft +
      (parseFloat(style.paddingLeft) || 0)
  return items.reduce<HTMLElement | undefined>((nearest, item) => {
    if (!nearest) return item
    const itemPosition = vertical
      ? item.getBoundingClientRect().top
      : item.getBoundingClientRect().left
    const nearestPosition = vertical
      ? nearest.getBoundingClientRect().top
      : nearest.getBoundingClientRect().left
    return Math.abs(itemPosition - anchor) < Math.abs(nearestPosition - anchor)
      ? item
      : nearest
  }, undefined)
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
  refreshNavigationLayout()
}

async function loadOlder(): Promise<void> {
  await commentsStore.loadOlder().catch(() => {
    FloatMsgs.show({
      type: 'error',
      msg: '<span class="ui zh">加载历史留言失败</span><span class="ui en">Failed to load older messages</span>',
    })
  })
  await nextTick()
  refreshNavigationLayout()
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
  updateSeekAvailability()
}

function observeNavigationLayout(): void {
  navigationResizeObserver?.disconnect()
  const element = container.value
  if (!element || !navigationResizeObserver) return
  navigationResizeObserver.observe(element)
  Array.from(element.children)
    .filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains('commentBox'),
    )
    .forEach((child) => navigationResizeObserver?.observe(child))
}

function refreshNavigationLayout(): void {
  observeNavigationLayout()
  navigationController?.reconcileLayout()
  updateSeekAvailability()
  updateVisibleTime()
}

function hasScrollableWheelTarget(event: WheelEvent): boolean {
  return event.composedPath().some((target) => {
    if (!(target instanceof HTMLElement)) return false
    const overflowY = window.getComputedStyle(target).overflowY
    return (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      target.scrollHeight > target.clientHeight
    )
  })
}

function handleDocumentWheel(event: WheelEvent): void {
  if (
    document.body.classList.contains('fullscreen') ||
    event.deltaX ||
    !event.deltaY
  )
    return
  if (hasScrollableWheelTarget(event)) return
  const target = event.target
  if (panel.value && target instanceof Node && panel.value.contains(target))
    return
  if (event.deltaY > 0) {
    forceLowerPanelUp()
  } else if (panelMode.value === 'forced-up') {
    forceLowerPanelDown()
  } else {
    return
  }
  event.preventDefault()
}

function handleDocumentClick(event: MouseEvent): void {
  if (
    panelMode.value !== 'forced-up' ||
    !panel.value ||
    (event.target instanceof Node && panel.value.contains(event.target))
  )
    return
  forceLowerPanelDown()
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
  async (items) => {
    syncEnteringComments()
    requestPaginationCheck()
    void nextTick(refreshNavigationLayout)
    if (items.length > 0) await recordInitialCommentDomReady()
  },
  { flush: 'post' },
)

watch(
  () => [pinnedHidden.value, editorOpen.value] as const,
  () => void nextTick(refreshNavigationLayout),
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
    finishPerformanceMark('comments-initial')
  },
  { flush: 'post' },
)

function handleWheel(event: WheelEvent): void {
  if (
    scrollPaused ||
    document.body.classList.contains('fullscreen') ||
    !container.value
  )
    return

  if (event.deltaX) {
    const maximum = Math.max(
      0,
      container.value.scrollWidth - container.value.clientWidth,
    )
    if (
      (event.deltaX < 0 && container.value.scrollLeft <= 0) ||
      (event.deltaX > 0 && container.value.scrollLeft >= maximum - 1)
    )
      event.preventDefault()
    return
  }
  if (!event.deltaY) return
  if (
    event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
    Math.abs(event.deltaY) < 10
  )
    return

  const protectedTarget = event.composedPath().some((target) => {
    if (!(target instanceof HTMLElement)) return false
    if (
      target.id === 'msgText' ||
      target.matches(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )
    )
      return true
    return (
      target.classList.contains('comment') &&
      target.scrollHeight > target.clientHeight
    )
  })
  if (protectedTarget) return

  event.preventDefault()
  navigationController?.seekByItems(event.deltaY < 0 ? -1 : 1)
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

function handleCommentsEntranceStart(event: AnimationEvent): void {
  if (
    event.target !== event.currentTarget ||
    event.animationName !== 'commentsUp'
  )
    return
  if (commentsEntranceRecorded) return
  commentsEntranceRecorded = true
  markPerformanceEvent('first-comment-animation-start')
  initialAnimationStarted.value = true
}

function syncEnteringComments(): void {
  const ids = commentsStore.consumeAnimationIds()
  if (!ids.size) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  enteringCommentIds.value = new Set([...enteringCommentIds.value, ...ids])
}

function finishCommentAnimation(id: number, event: AnimationEvent): void {
  if (
    event.target !== event.currentTarget ||
    event.animationName !== 'newCommentUp'
  )
    return
  const next = new Set(enteringCommentIds.value)
  next.delete(id)
  enteringCommentIds.value = next
}

function finishCommentsEntrance(event: AnimationEvent): void {
  if (
    event.target !== event.currentTarget ||
    event.animationName !== 'commentsUp'
  )
    return
  markPerformanceEvent('first-comment-animation-end')
  commentsEntrancePlaying.value = false
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
  container.value?.addEventListener('wheel', handleWheel, { passive: false })
  document.addEventListener('touchstart', handlePanelTouchStart, {
    passive: true,
  })
  document.addEventListener('touchmove', handlePanelTouchMove, {
    passive: false,
  })
  document.addEventListener('touchend', handlePanelTouchEnd, {
    passive: true,
  })
  document.addEventListener('touchcancel', handlePanelTouchCancel, {
    passive: true,
  })
  if (container.value) {
    navigationController = createCommentNavigationController(container.value)
    navigationResizeObserver = new ResizeObserver(() =>
      navigationController?.reconcileLayout(),
    )
    observeNavigationLayout()
  }
  document.addEventListener('elytrue:seek-comment', onSeek)
  document.addEventListener('elytrue:open-comment-editor', onOpenEditor)
  document.addEventListener('pointermove', handleDocumentPointerMove)
  document.addEventListener('wheel', handleDocumentWheel, { passive: false })
  document.addEventListener('click', handleDocumentClick)
  setupPaginationObserver()
  syncEnteringComments()
  void recordInitialCommentDomReady()
  void nextTick(() => {
    refreshNavigationLayout()
  })
  bodyObserver = new MutationObserver(() => {
    if (document.body.classList.contains('fullscreen')) {
      commentsEntrancePlaying.value = false
      navigationController?.cancel(false)
      settleCancelledTouchGesture()
    }
    requestPaginationCheck()
    void nextTick(refreshNavigationLayout)
  })
  bodyObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })
})

onBeforeUnmount(() => {
  container.value?.removeEventListener('scroll', handleScroll)
  container.value?.removeEventListener('wheel', handleWheel)
  document.removeEventListener('touchstart', handlePanelTouchStart)
  document.removeEventListener('touchmove', handlePanelTouchMove)
  document.removeEventListener('touchend', handlePanelTouchEnd)
  document.removeEventListener('touchcancel', handlePanelTouchCancel)
  document.removeEventListener('elytrue:seek-comment', onSeek)
  document.removeEventListener('elytrue:open-comment-editor', onOpenEditor)
  document.removeEventListener('pointermove', handleDocumentPointerMove)
  document.removeEventListener('wheel', handleDocumentWheel)
  document.removeEventListener('click', handleDocumentClick)
  if (pauseTimer !== undefined) window.clearTimeout(pauseTimer)
  disposePaginationObserver()
  navigationResizeObserver?.disconnect()
  navigationResizeObserver = undefined
  navigationController?.destroy()
  navigationController = undefined
  bodyObserver?.disconnect()
  bodyObserver = undefined
  settleCancelledTouchGesture()
  clearTouchPanelTransform()
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
      animating: commentsEntrancePlaying,
      lowerPanelUp: panelMode === 'forced-up',
      lowerPanelDown: panelMode === 'forced-down',
    }"
    @animationstart="handleCommentsEntranceStart"
    @animationend="finishCommentsEntrance"
    @animationcancel="finishCommentsEntrance"
    @pointerleave="handlePanelPointerLeave"
  >
    <div class="tooltip">
      <span class="todayCommentText"
        ><span class="ui zh">今日留言: </span
        ><span class="ui en">Messages today: </span
        ><span id="todayCommentCount">{{
          commentsStore.state.todayCount
        }}</span></span
      >
    </div>
    <div
      id="comments"
      ref="container"
      :class="{ noscrollbar: Settings.showTimeline }"
    >
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
        <img class="bg" :src="pinnedBackground" loading="eager" />
        <div class="bgcover"></div>
        <StableAvatar
          class="avatar"
          src="/assets/elytrue-shell-20260805/favicon-320-c998712d.png"
          loading="eager"
        />
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
            ><br />请勿发布广告、骚扰、违法、侵权或不适宜内容。<br /><br />游客可以匿名留言和回复；登录后还可上传图片、点赞和举报。<br /><br /><a
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
            can post and reply anonymously. Sign in to upload images, like or
            report.<br /><br /><a
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
      <CommentCard
        v-for="(record, index) in commentsStore.state.items"
        :key="record.id"
        :record="record"
        :eager="index === 0"
        :entering="enteringCommentIds.has(record.id)"
        @animationend="finishCommentAnimation(record.id, $event)"
        @lift="forceLowerPanelUp"
        @reply="openEditor"
      />
      <div
        v-if="
          commentsStore.state.initialError && commentsStore.state.items.length
        "
        class="commentsRevalidateError"
      >
        <span class="ui zh">刷新留言失败</span>
        <span class="ui en">Failed to refresh messages</span>
        <button type="button" @click="retryInitialLoad">
          <span class="ui zh">重试</span><span class="ui en">Retry</span>
        </button>
      </div>
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
    <LegalLinks />
    <button
      v-if="canSeekLeft"
      type="button"
      class="commentSeekArrow semanticButton"
      style="left: 2vw"
      aria-label="上一页留言"
      @click="seek(-1)"
    >
      <img src="/res/arrow_left.svg" alt="" />
    </button>
    <button
      v-if="canSeekRight"
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
