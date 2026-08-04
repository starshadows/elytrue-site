<script setup lang="ts">
import { ref } from 'vue'
import XHR from '../../net/xhr'
import Popups from './index'

const emit = defineEmits<{ close: [] }>()
const currentPassword = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  if (!currentPassword.value || busy.value) return
  busy.value = true
  try {
    const response = await XHR.post<{ recoveryKey: string }>(
      'user/recovery-key',
      { currentPassword: currentPassword.value },
    )
    if (response.code !== 1) return
    emit('close')
    Popups.show('recoveryKeyPopup', {
      recoveryKey: response.data.recoveryKey,
      reason: 'rotation',
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="recoveryKeySetupPopup">
    <h2>
      <span class="ui zh">生成恢复密钥</span
      ><span class="ui en">Generate recovery key</span>
    </h2>
    <p>
      <span class="ui zh"
        >输入当前密码后将生成新的恢复密钥，旧密钥会立即失效。</span
      ><span class="ui en"
        >Enter your current password to generate a new recovery key. The old key
        will stop working immediately.</span
      >
    </p>
    <div class="inputHelperText">
      <span class="ui zh">当前密码</span
      ><span class="ui en">Current password</span>
    </div>
    <input
      v-model="currentPassword"
      type="password"
      autocomplete="current-password"
      @keypress="(event) => event.key === 'Enter' && submit()"
    />
    <button class="okBtn" :disabled="!currentPassword || busy" @click="submit">
      <span class="ui zh">{{ busy ? '正在生成…' : '生成 →' }}</span>
      <span class="ui en">{{ busy ? 'Generating…' : 'Generate →' }}</span>
    </button>
  </div>
</template>

<style scoped>
.recoveryKeySetupPopup {
  width: 22rem;
  max-width: 75vw;
}

p {
  max-width: 22rem;
  margin-bottom: 1rem;
  line-height: 1.55;
}
</style>
