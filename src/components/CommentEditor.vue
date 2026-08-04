<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { ApiError } from '../lib/api-client'
import { resizeImage } from '../lib/image'
import {
  avatarPath,
  ensureLoggedIn,
  refreshAuth,
  runProfileAction,
} from '../features/auth/auth-actions'
import { authStore } from '../features/auth/auth-store'
import { commentsApi } from '../features/comments/comments-api'
import type { CommentRecord } from '../features/comments/comment-types'
import FloatMsgs from './FloatMsgs'
import ImgViewer from './ImgViewer'
import Popups from './Popups'

const props = defineProps<{ replyNumber?: number }>()
const emit = defineEmits<{ close: []; focus: []; sent: [] }>()
const text = useTemplateRef<HTMLDivElement>('text')
const picker = useTemplateRef<HTMLInputElement>('picker')
const uploads = ref<string[]>([])
const reply = ref<CommentRecord | null>(null)
const sending = ref(false)
const sender = computed(() => authStore.state.profile?.name ?? '匿名用户')
const avatar = computed(() => avatarPath(authStore.state.profile?.avatar))

onMounted(async () => {
  if (!(await ensureLoggedIn())) {
    FloatMsgs.show({
      type: 'warn',
      msg: '<span class="ui zh">登录后即可留言</span><span class="ui en">Log in to leave a message</span>',
    })
    emit('close')
    return
  }
  if (props.replyNumber) {
    reply.value =
      (
        await commentsApi
          .list({ number: props.replyNumber, count: 1 })
          .catch(() => null)
      )?.items[0] ?? null
  }
  await nextTick()
  text.value?.focus({ preventScroll: true })
})

async function previewImages(): Promise<void> {
  const files = picker.value?.files
  if (!files) return
  const remaining = Math.max(0, 3 - uploads.value.length)
  if (!remaining) {
    FloatMsgs.show({
      type: 'warn',
      msg: '<span class="ui zh">每条留言最多上传 3 张图片</span><span class="ui en">Up to 3 images per message</span>',
    })
    return
  }
  for (const file of Array.from(files).slice(0, remaining)) {
    uploads.value.push(await resizeImage(file, undefined, 2.1e6))
  }
  if (picker.value) picker.value.value = ''
}

async function send(): Promise<void> {
  if (sending.value || !(await ensureLoggedIn())) return
  const comment = text.value?.innerText ?? ''
  if (!comment.replace(/\s/g, '')) {
    FloatMsgs.show({
      type: 'warn',
      msg: '<span class="ui zh">留言不能为空!</span><span class="ui en">Do not leave the message empty!</span>',
    })
    return
  }
  sending.value = true
  const uploaded: string[] = []
  try {
    for (const source of uploads.value) {
      const image = source.split(';base64,')[1]
      if (image) uploaded.push(await commentsApi.upload(image))
    }
    const payload = {
      comment,
      imageKeys: uploaded,
      ...(reply.value ? { replyid: reply.value.displayId } : {}),
    }
    try {
      await commentsApi.create(payload)
    } catch (error) {
      const csrfRejected =
        error instanceof ApiError &&
        error.status === 403 &&
        error.message.includes('安全校验失败')
      if (!csrfRejected || !(await refreshAuth())) throw error
      await commentsApi.create(payload)
    }
    emit('sent')
  } catch (error) {
    void Promise.allSettled(uploaded.map((id) => commentsApi.deleteUpload(id)))
    const reason =
      error instanceof Error && error.message ? `：${error.message}` : ''
    window.alert(
      `发送留言失败${reason}。请稍后重试。\n\nFailed to send the message. Please try again later.`,
    )
    sending.value = false
    return
  }
  emit('close')
}
</script>

<template>
  <div id="newCommentBox" class="commentBox">
    <div class="bgcover"></div>
    <img
      id="msgPopupAvatar"
      class="avatar"
      :src="avatar"
      @click="runProfileAction('changeAvatar')"
    />
    <div id="senderText" class="sender" @click="runProfileAction('changeName')">
      {{ sender }}
    </div>
    <div class="id" @click="Popups.show('loginPopup')">
      <span class="ui zh">注册/登录</span
      ><span class="ui en">Login / Register</span>
    </div>
    <div class="comment">
      <div
        ref="text"
        id="msgText"
        placeholder="愿花与星辉伴你同行♪"
        contenteditable="true"
        @focus="emit('focus')"
      ></div>
      <div
        v-if="reply"
        id="newCommentReplyQuote"
        class="comment-reply-quote dark"
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
      <div id="uploadImgList">
        <div v-for="(source, index) in uploads" :key="source">
          <img
            :src="source"
            class="uploadImg"
            @click="ImgViewer.view(source)"
          /><button @click="uploads.splice(index, 1)">❌</button>
        </div>
      </div>
    </div>
    <label
      ><input
        ref="picker"
        id="uploadImgPicker"
        type="file"
        accept="image/*"
        multiple
        style="display: none"
        @change="previewImages"
      /><span
        ><span class="ui zh">+ 添加图片</span
        ><span class="ui en">+ Add images</span></span
      ></label
    >
    <div class="messageActions">
      <button id="cancelSendBtn" :disabled="sending" @click="emit('close')">
        <span class="ui zh">取消发送</span
        ><span class="ui en">Cancel</span></button
      ><button id="sendBtn" :disabled="sending" @click="send">
        <span class="ui zh">{{ sending ? '正在发送…' : '发送 ✔' }}</span
        ><span class="ui en">{{ sending ? 'Sending…' : 'Send ✔' }}</span>
      </button>
    </div>
  </div>
</template>
