<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import FloatMsgs from './FloatMsgs'
import ImgViewer from './ImgViewer'
import Popups from './Popups'
import { avatarPath, ensureLoggedIn } from '../features/auth/auth-actions'
import { authStore } from '../features/auth/auth-store'
import { commentsApi } from '../features/comments/comments-api'
import { commentsStore } from '../features/comments/comments-store'
import type { CommentRecord } from '../features/comments/comment-types'
import { BACKGROUNDS } from '../config/assets'

const props = defineProps<{ record: CommentRecord }>()
const emit = defineEmits<{ lift: []; reply: [number: number] }>()
const reply = ref<CommentRecord | null>(null)
const likeBusy = ref(false)
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

onMounted(async () => {
  if (!props.record.replyid) return
  reply.value =
    (
      await commentsApi
        .list({ from: props.record.replyid, count: 1 })
        .catch(() => null)
    )?.items[0] ?? null
})

async function toggleLike(): Promise<void> {
  if (likeBusy.value) return
  likeBusy.value = true
  if (!(await ensureLoggedIn())) {
    likeBusy.value = false
    return
  }
  await commentsStore.toggleLike(props.record.id).catch(() => undefined)
  window.setTimeout(() => (likeBusy.value = false), 1_000)
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
  if (reply.value)
    void commentsStore.gotoNumber(reply.value.number ?? reply.value.displayId)
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
    :class="{ hidden: record.hidden }"
    :data-uid="record.uid ?? ''"
    :data-number="record.displayId"
    :data-timestamp="record.time"
  >
    <img
      class="bg"
      loading="lazy"
      :src="background"
      :style="record.hidden ? { display: 'none' } : undefined"
    />
    <div class="bgcover"></div>
    <img
      class="avatar"
      loading="lazy"
      :src="avatarPath(record.avatar)"
      @click="openUser"
    />
    <div class="sender" @click="openUser">
      <template v-if="record.sender === '匿名用户'"
        ><span class="ui zh">匿名用户</span
        ><span class="ui en">Anonymous</span></template
      >
      <template v-else>{{ record.sender }}</template>
    </div>
    <div class="id">#{{ record.displayId }}</div>
    <div class="comment">
      {{ record.comment }}
      <div
        v-if="reply"
        class="reply-quote comment-reply-quote clickable"
        @click="openReply"
      >
        <img class="reply-icon" src="/res/reply.svg" />
        <div class="quote-content">
          <div class="quote-head">
            <img class="quote-avatar" :src="avatarPath(reply.avatar)" />
            <div class="quote-sender">{{ reply.sender }}</div>
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
        @click="openImage(image)"
      />
    </div>
    <div class="time">
      {{ date.toLocaleDateString() }} {{ date.toLocaleTimeString()
      }}{{ record.hidden ? ' (hidden)' : '' }}
    </div>
    <div class="action">
      <span
        class="btn like"
        :class="{ liked: record.liked, busy: likeBusy }"
        @click="toggleLike"
      >
        <span
          class="like-count"
          :style="{ display: record.likes ? 'block' : 'none' }"
          >{{ record.likes }}</span
        >
      </span>
      <img class="btn reply" src="/res/reply.svg" @click="replyToComment" />
      <span v-if="canReport" class="btn report" @click="report"
        ><span class="ui zh">举报</span><span class="ui en">Report</span></span
      >
    </div>
  </div>
</template>
