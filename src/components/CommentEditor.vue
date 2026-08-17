<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { ApiError } from '../lib/api-client'
import { resizeImage } from '../lib/image'
import {
  avatarPath,
  initializeAuth,
  refreshAuth,
  runProfileAction,
} from '../features/auth/auth-actions'
import { authStore } from '../features/auth/auth-store'
import { commentsApi } from '../features/comments/comments-api'
import type { CommentRecord } from '../features/comments/comment-types'
import { finishPerformanceMark, startPerformanceMark } from '../lib/performance'
import FloatMsgs from './FloatMsgs'
import ImgViewer from './ImgViewer'
import Popups from './Popups'
import StableAvatar from './StableAvatar.vue'

const props = defineProps<{ replyNumber?: number }>()
const emit = defineEmits<{
  close: []
  focus: []
  sent: [comment: CommentRecord]
}>()
const text = useTemplateRef<HTMLDivElement>('text')
const picker = useTemplateRef<HTMLInputElement>('picker')
const uploads = ref<string[]>([])
const reply = ref<CommentRecord | null>(null)
const sending = ref(false)
const authenticated = computed(() => authStore.authenticated.value)
const sender = computed(() => authStore.state.profile?.name ?? '匿名用户')
const avatar = computed(() => avatarPath(authStore.state.profile?.avatar))

onMounted(async () => {
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
  if (sending.value) return
  if (authStore.state.loginState === 'loading') await initializeAuth()
  const comment = text.value?.innerText ?? ''
  if (!comment.replace(/\s/g, '')) {
    FloatMsgs.show({
      type: 'warn',
      msg: '<span class="ui zh">留言不能为空!</span><span class="ui en">Do not leave the message empty!</span>',
    })
    return
  }
  sending.value = true
  startPerformanceMark('comment-post')
  const uploaded: string[] = []
  try {
    if (authenticated.value) {
      for (const source of uploads.value) {
        const image = source.split(';base64,')[1]
        if (image) uploaded.push(await commentsApi.upload(image))
      }
    }
    const payload = {
      comment,
      imageKeys: uploaded,
      ...(reply.value ? { replyid: reply.value.displayId } : {}),
    }
    try {
      const created = await commentsApi.create(payload)
      emit('sent', created)
    } catch (error) {
      const csrfRejected =
        error instanceof ApiError &&
        error.status === 403 &&
        error.message.includes('安全校验失败')
      if (!csrfRejected || !authenticated.value || !(await refreshAuth()))
        throw error
      const created = await commentsApi.create(payload)
      emit('sent', created)
    }
  } catch (error) {
    await Promise.allSettled(uploaded.map((id) => commentsApi.deleteUpload(id)))
    const reason =
      error instanceof Error && error.message ? `：${error.message}` : ''
    window.alert(
      `发送留言失败${reason}。请稍后重试。\n\nFailed to send the message. Please try again later.`,
    )
    sending.value = false
    finishPerformanceMark('comment-post')
    return
  }
  finishPerformanceMark('comment-post')
  emit('close')
}
</script>

<template>
  <div id="newCommentBox" class="commentBox">
    <div class="bgcover"></div>
    <StableAvatar
      id="msgPopupAvatar"
      class="avatar"
      :src="avatar"
      :alt="`${sender}的头像`"
      role="button"
      tabindex="0"
      @click="
        authenticated
          ? runProfileAction('changeAvatar')
          : Popups.show('loginPopup')
      "
      @keydown.enter="
        authenticated
          ? runProfileAction('changeAvatar')
          : Popups.show('loginPopup')
      "
      @keydown.space.prevent="
        authenticated
          ? runProfileAction('changeAvatar')
          : Popups.show('loginPopup')
      "
    />
    <button
      id="senderText"
      type="button"
      class="sender semanticButton"
      @click="
        authenticated
          ? runProfileAction('changeName')
          : Popups.show('loginPopup')
      "
    >
      {{ sender }}
    </button>
    <button
      type="button"
      class="id semanticButton"
      @click="Popups.show('loginPopup')"
    >
      <span class="ui zh">注册/登录</span
      ><span class="ui en">Login / Register</span>
    </button>
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
        <img class="reply-icon" src="/res/reply.svg" alt="" />
        <div class="quote-content">
          <div class="quote-head">
            <StableAvatar
              class="quote-avatar"
              :src="avatarPath(reply.avatar)"
              alt=""
            />
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
            alt="待上传图片"
            role="button"
            tabindex="0"
            @click="ImgViewer.view(source)"
            @keydown.enter="ImgViewer.view(source)"
            @keydown.space.prevent="ImgViewer.view(source)"
          /><button
            type="button"
            :aria-label="`移除第 ${index + 1} 张图片`"
            @click="uploads.splice(index, 1)"
          >
            ❌
          </button>
        </div>
      </div>
    </div>
    <label v-if="authenticated"
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
      <button
        id="cancelSendBtn"
        type="button"
        :disabled="sending"
        @click="emit('close')"
      >
        <span class="ui zh">取消发送</span
        ><span class="ui en">Cancel</span></button
      ><button id="sendBtn" type="button" :disabled="sending" @click="send">
        <span class="ui zh">{{ sending ? '正在发送…' : '发送 ✔' }}</span
        ><span class="ui en">{{ sending ? 'Sending…' : 'Send ✔' }}</span>
      </button>
    </div>
  </div>
</template>
