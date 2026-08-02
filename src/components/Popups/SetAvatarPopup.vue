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
  </div>
</template>

<script setup lang="ts">
import { onMounted, useTemplateRef } from 'vue'
import { requireController, viewImage } from '../../app/controller'
import XHR from '../../net/xhr'
import FloatMsgs from '../FloatMsgs'

const emit = defineEmits<{ close: [] }>()
const preview = useTemplateRef<HTMLImageElement>('preview')
const input = useTemplateRef<HTMLInputElement>('input')

async function previewAvatar(): Promise<void> {
  const file = input.value?.files?.[0]
  if (!file || !preview.value) return
  const result = await requireController().resizeImg(file, 1, 200 * 200)
  if (typeof result === 'string') preview.value.src = result
}

function viewPreview(): void {
  if (preview.value?.src) viewImage(preview.value.src)
}

async function uploadAvatar(): Promise<void> {
  const avatar = preview.value?.src.split(';base64,')[1]
  if (!avatar) {
    emit('close')
    return
  }
  const response = await XHR.put('user/update', { avatar })
  if (response.code === 1) {
    emit('close')
    FloatMsgs.show({
      type: 'success',
      msg: '<span class="ui zh">上传成功</span><span class="ui en">Uploaded successfully</span>',
    })
    await requireController().loadUserInfo()
  }
}

onMounted(async () => {
  const controller = requireController()
  const user = (await controller.User.getMe()) as { avatar: string }
  if (preview.value) {
    preview.value.src = controller.User.convertAvatarPath(user.avatar)
  }
})
</script>
