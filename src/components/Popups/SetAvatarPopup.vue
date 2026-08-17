<template>
  <div class="setAvatarPopup">
    <h2>
      <span class="ui zh">设置头像</span><span class="ui en">Set avatar</span>
    </h2>
    <img ref="preview" class="setAvatarImg" @click="viewPreview" />
    <input ref="input" type="file" accept="image/*" @change="previewAvatar" />
    <br />
    <button class="okBtn" @click="uploadAvatar()">
      <span class="ui zh">确定 ✔</span><span class="ui en">OK ✔</span>
    </button>
    <button v-if="currentAvatar" class="cancelBtn" @click="useDefaultAvatar()">
      <span class="ui zh">恢复默认头像</span
      ><span class="ui en">Use default</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from 'vue'
import {
  applyUpdatedProfile,
  avatarPath,
} from '../../features/auth/auth-actions'
import { authStore, type UserProfile } from '../../features/auth/auth-store'
import { resizeImage } from '../../lib/image'
import XHR from '../../net/xhr'
import FloatMsgs from '../FloatMsgs'
import ImgViewer from '../ImgViewer'

const emit = defineEmits<{ close: [] }>()
const preview = useTemplateRef<HTMLImageElement>('preview')
const input = useTemplateRef<HTMLInputElement>('input')
const currentAvatar = ref('')
const selectedAvatar = ref('')

async function previewAvatar(): Promise<void> {
  const file = input.value?.files?.[0]
  if (!file || !preview.value) return
  const result = await resizeImage(file, 1, 200 * 200)
  if (typeof result === 'string') {
    preview.value.src = result
    selectedAvatar.value = result.split(';base64,')[1] || ''
  }
}

function viewPreview(): void {
  if (preview.value?.src) ImgViewer.view(preview.value.src)
}

async function uploadAvatar(): Promise<void> {
  const avatar = selectedAvatar.value
  if (!avatar) {
    emit('close')
    return
  }
  const response = await XHR.put<UserProfile>('user/update', { avatar })
  if (response.code === 1) {
    applyUpdatedProfile(response.data)
    emit('close')
    FloatMsgs.show({
      type: 'success',
      msg: '<span class="ui zh">上传成功</span><span class="ui en">Uploaded successfully</span>',
    })
  }
}

async function useDefaultAvatar(): Promise<void> {
  const response = await XHR.put<UserProfile>('user/update', { avatar: '' })
  if (response.code !== 1) return
  applyUpdatedProfile(response.data)
  emit('close')
  FloatMsgs.show({
    type: 'success',
    msg: '<span class="ui zh">已恢复默认头像</span><span class="ui en">Default avatar restored</span>',
  })
}

onMounted(async () => {
  const user = authStore.state.profile ?? (await authStore.ready())
  if (user && preview.value) {
    currentAvatar.value = user.avatar
    preview.value.src = avatarPath(user.avatar)
  }
})
</script>
