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

const emit = defineEmits<{ fullscreen: []; install: [] }>()
const container = useTemplateRef<HTMLDivElement>('container')
const panel = useTemplateRef<HTMLDivElement>('panel')
const editorOpen = ref(false)
const replyNumber = ref<number>()
const pinnedHidden = computed(() => Settings.pinnedHidden)
let scrollPaused = false
let pauseTimer: number | undefined
let scrollTimer: number | undefined

function forceLowerPanelUp(): void {
  panel.value?.classList.add('lowerPanelUp')
  panel.value?.classList.remove('lowerPanelDown')
  document.documentElement.style.overscrollBehavior = 'contain'
  document.body.style.overscrollBehavior = 'contain'
}

function forceLowerPanelDown(): void {
  panel.value?.classList.remove('lowerPanelUp')
  panel.value?.classList.add('lowerPanelDown')
  document.documentElement.style.removeProperty('overscroll-behavior')
  document.body.style.removeProperty('overscroll-behavior')
  document.getElementById('msgText')?.blur()
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
  await commentsStore.loadNewer(
    document.body.classList.contains('fullscreen') ? 18 : 10,
  )
  await nextTick()
  if (element && anchor && before) {
    const after = anchor.getBoundingClientRect()
    if (document.body.classList.contains('fullscreen'))
      element.scrollTop += after.top - before.top
    else element.scrollLeft += after.left - before.left
  }
}

function handleScroll(): void {
  if (
    scrollPaused ||
    !container.value ||
    !commentsStore.state.items.length ||
    commentsStore.state.jumping
  )
    return
  updateVisibleTime()
  const element = container.value
  const vertical = document.body.classList.contains('fullscreen')
  const start = vertical ? element.scrollTop : element.scrollLeft
  const end = vertical
    ? element.scrollHeight - element.clientHeight - element.scrollTop
    : element.scrollWidth - element.clientWidth - element.scrollLeft
  const threshold =
    (currentItem()?.getBoundingClientRect()[vertical ? 'height' : 'width'] ??
      80) / 8
  if (start <= threshold && !commentsStore.state.reachedNewest) void loadNewer()
  if (end <= threshold && !commentsStore.state.reachedOldest)
    void commentsStore.loadOlder()
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
  void commentsStore.initialize().then(() => nextTick(updateVisibleTime))
  container.value?.addEventListener('scroll', handleScroll)
  container.value?.addEventListener('wheel', handleWheel)
  document.addEventListener('elytrue:seek-comment', onSeek)
  document.addEventListener('elytrue:open-comment-editor', onOpenEditor)
  scrollTimer = window.setInterval(handleScroll, 1_000)
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
  if (pauseTimer !== undefined) window.clearTimeout(pauseTimer)
  if (scrollTimer !== undefined) window.clearInterval(scrollTimer)
})

defineExpose({ forceLowerPanelDown, forceLowerPanelUp, pauseScroll })
</script>

<template>
  <div id="lowerPanel" ref="panel">
    <div class="tooltip">
      <span class="ui zh">今日留言: </span
      ><span class="ui en">Messages today: </span
      ><span id="todayCommentCount">{{ commentsStore.state.todayCount }}</span>
    </div>
    <div id="comments" ref="container" class="noscrollbar">
      <div v-show="!pinnedHidden" id="topComment" class="commentBox">
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
        <div
          class="time"
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
        </div>
      </div>
      <CommentEditor
        v-if="editorOpen"
        :reply-number="replyNumber"
        @close="closeEditor"
        @focus="forceLowerPanelUp"
      />
      <div
        id="loadingIndicatorBefore"
        class="commentBox loadingIndicator"
        :style="{ display: commentsStore.state.loadingNewer ? '' : 'none' }"
      >
        <div class="loadingCircle"></div>
      </div>
      <CommentCard
        v-for="record in commentsStore.state.items"
        :key="record.id"
        :record="record"
        @lift="forceLowerPanelUp"
        @reply="openEditor"
      />
      <div
        id="loadingIndicator"
        class="commentBox loadingIndicator"
        :style="{ display: commentsStore.state.reachedOldest ? 'none' : '' }"
      >
        <div class="loadingCircle"></div>
      </div>
    </div>
    <TimelinePanel />
    <div class="commentSeekArrow" style="left: 2vw" @click="seek(-1)">
      <img src="/res/arrow_left.svg" />
    </div>
    <div class="commentSeekArrow" style="right: 2vw" @click="seek(1)">
      <img src="/res/arrow_right.svg" />
      <div id="mouseScrollTooltip" class="tooltip">
        <span class="ui zh">用鼠标滚轮也可滚动</span
        ><span class="ui en">Scrollable with wheel</span>
      </div>
    </div>
    <ToolsPanel
      @new-comment="openEditor()"
      @fullscreen="emit('fullscreen')"
      @install="emit('install')"
    />
  </div>
</template>
