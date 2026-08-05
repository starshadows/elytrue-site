<script setup lang="ts">
import { computed } from 'vue'
import FloatMsgs from './FloatMsgs'
import ImgViewer from './ImgViewer'
import Popups from './Popups'
import { avatarPath, ensureLoggedIn } from '../features/auth/auth-actions'
import { authStore } from '../features/auth/auth-store'
import { commentsApi } from '../features/comments/comments-api'
import { commentsStore } from '../features/comments/comments-store'
import type {
  CommentRecord,
  ReplyPreview,
} from '../features/comments/comment-types'
import { BACKGROUNDS } from '../config/assets'
import StableAvatar from './StableAvatar.vue'

const props = defineProps<{
  record: CommentRecord
  eager?: boolean
  entering?: boolean
}>()
const emit = defineEmits<{ lift: []; reply: [number: number] }>()
const reply = computed<ReplyPreview | null>(
  () => props.record.replyPreview ?? null,
)
const likePending = computed(() => commentsStore.isLikePending(props.record.id))
const images = computed(() =>
  props.record.image ? props.record.image.split(',').filter(Boolean) : [],
)
const background = computed(() => {
  const portraits = BACKGROUNDS.filter((item) => item.layout === 'portrait')
  return portraits[Math.abs(props.record.id) % portraits.length]?.preview ?? ''
})
const date = computed(() => new Date(props.record.time * 1_000))
const canReport = computed(
  () =>
    authStore.state.userId !== null &&
    authStore.state.userId !== props.record.uid,
)

async function toggleLike(): Promise<void> {
  if (likePending.value || !(await ensureLoggedIn())) return
  await commentsStore.toggleLike(props.record.id).catch(() => undefined)
}

async function replyToComment(): Promise<void> {
  if (await ensureLoggedIn())
    emit('reply', props.record.number ?? props.record.displayId)
}

function openUser(): void {
  if (props.record.uid) {
    Popups.show('userHome', {
      id: props.record.uid,
      name: props.record.sender,
      avatar: props.record.avatar,
    })
  }
  emit('lift')
}

function openImage(image: string): void {
  ImgViewer.view(`/api/data/images/posts/${image}.jpg`)
  emit('lift')
}

function openReply(): void {
  if (!reply.value || reply.value.deleted) return
  const jump = reply.value.number
    ? commentsStore.gotoNumber(reply.value.number)
    : reply.value.id
      ? commentsStore.gotoId(reply.value.id)
      : commentsStore.gotoNumber(reply.value.displayId)
  void jump.catch(() => undefined)
}

function report(): void {
  Popups.show('promptInputPopup', {
    title: `<span class="ui zh">举报留言 #${props.record.displayId}</span><span class="ui en">Report message #${props.record.displayId}</span>`,
    subtitle:
      '<span class="ui zh">请简要描述举报原因，管理员核实后会处理。</span><span class="ui en">Please describe the reason briefly. Moderators will review it.</span>',
    action(
      reason: string,
      context: { close(): void; setDisabled(value: boolean): void },
    ) {
      context.setDisabled(true)
      void commentsApi
        .report(props.record.id, reason)
        .then(() => {
          context.close()
          FloatMsgs.show({
            type: 'success',
            persist: true,
            msg: '<span class="ui zh">举报已提交，感谢反馈</span><span class="ui en">Report submitted. Thank you.</span>',
          })
        })
        .finally(() => context.setDisabled(false))
    },
  })
}
</script>

<template>
  <div
    :id="`#${record.id}`"
    class="commentBox commentItem"
    :class="{ commentEnter: entering, hidden: record.hidden }"
    :data-uid="record.uid ?? ''"
    :data-number="record.displayId"
    :data-timestamp="record.time"
  >
    <img
      class="bg"
      :loading="eager ? 'eager' : 'lazy'"
      :src="background"
      alt=""
      :style="record.hidden ? { display: 'none' } : undefined"
    />
    <div class="bgcover"></div>
    <StableAvatar
      class="avatar"
      :src="avatarPath(record.avatar)"
      :alt="`${record.sender}的头像`"
      :loading="eager ? 'eager' : 'lazy'"
      role="button"
      tabindex="0"
      @click="openUser"
      @keydown.enter="openUser"
      @keydown.space.prevent="openUser"
    />
    <button type="button" class="sender semanticButton" @click="openUser">
      <template v-if="record.sender === '匿名用户'"
        ><span class="ui zh">匿名用户</span
        ><span class="ui en">Anonymous</span></template
      >
      <template v-else>{{ record.sender }}</template>
    </button>
    <div class="id">#{{ record.displayId }}</div>
    <div class="comment">
      {{ record.comment }}
      <div
        v-if="reply"
        class="reply-quote comment-reply-quote clickable"
        :role="reply.deleted ? undefined : 'button'"
        :tabindex="reply.deleted ? undefined : 0"
        @click="openReply"
        @keydown.enter="openReply"
        @keydown.space.prevent="openReply"
      >
        <img class="reply-icon" src="/res/reply.svg" alt="" />
        <div class="quote-content">
          <div class="quote-head">
            <StableAvatar
              class="quote-avatar"
              :src="avatarPath(reply.avatar)"
              alt=""
            />
            <div class="quote-sender">{{ reply.sender || '留言已删除' }}</div>
            <div class="quote-id">#{{ reply.displayId }}</div>
          </div>
          <div class="quote-body">{{ reply.comment }}</div>
        </div>
      </div>
      <template v-if="images.length"><br /><br /></template>
      <img
        v-for="image in images"
        :key="image"
        loading="lazy"
        :src="`/api/data/images/posts/${image}.jpg`"
        alt="留言图片"
        role="button"
        tabindex="0"
        @click="openImage(image)"
        @keydown.enter="openImage(image)"
        @keydown.space.prevent="openImage(image)"
      />
    </div>
    <div class="time">
      {{ date.toLocaleDateString() }} {{ date.toLocaleTimeString()
      }}{{ record.hidden ? ' (hidden)' : '' }}
    </div>
    <div class="action">
      <button
        type="button"
        class="btn like semanticButton"
        :class="{ liked: record.liked, busy: likePending }"
        :disabled="likePending"
        :aria-pressed="record.liked"
        :aria-label="record.liked ? '取消点赞' : '点赞'"
        @click="toggleLike"
      >
        <span
          class="like-count"
          :style="{ display: record.likes ? 'block' : 'none' }"
          >{{ record.likes }}</span
        >
      </button>
      <button
        type="button"
        class="btn reply semanticButton"
        aria-label="回复留言"
        @click="replyToComment"
      >
        <img src="/res/reply.svg" alt="" />
      </button>
      <button
        v-if="canReport"
        type="button"
        class="btn report semanticButton"
        @click="report"
      >
        <span class="ui zh">举报</span><span class="ui en">Report</span>
      </button>
    </div>
  </div>
</template>
