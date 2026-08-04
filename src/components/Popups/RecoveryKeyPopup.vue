<script setup lang="ts">
import { ref } from 'vue'
import FloatMsgs from '../FloatMsgs'
import Popups from './index'

const props = defineProps<{
  recoveryKey: string
  reason: 'registration' | 'recovery' | 'rotation'
}>()
const emit = defineEmits<{ close: [] }>()
const confirmed = ref(false)

async function copyKey(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.recoveryKey)
  } catch {
    const input = document.createElement('textarea')
    input.value = props.recoveryKey
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
  FloatMsgs.show({
    type: 'success',
    msg: '<span class="ui zh">恢复密钥已复制</span><span class="ui en">Recovery key copied</span>',
  })
}

function downloadKey(): void {
  const content = [
    '星花札记账号恢复密钥 / Starflower Notes account recovery key',
    '',
    props.recoveryKey,
    '',
    '请妥善离线保存。此密钥仅显示一次，不要发送给他人。',
    'Store this key safely. It is shown only once. Do not share it.',
  ].join('\n')
  const url = URL.createObjectURL(
    new Blob([content], { type: 'text/plain;charset=utf-8' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = 'elytrue-recovery-key.txt'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function finish(): void {
  if (!confirmed.value) return
  emit('close')
  if (props.reason === 'recovery') {
    Popups.show('loginPopup')
    FloatMsgs.show({
      type: 'success',
      msg: '<span class="ui zh">账号已恢复，请使用新密码登录</span><span class="ui en">Account recovered. Log in with your new password.</span>',
    })
  }
}
</script>

<template>
  <div class="recoveryKeyPopup">
    <h2>
      <span class="ui zh">保存账号恢复密钥</span
      ><span class="ui en">Save your recovery key</span>
    </h2>
    <p class="recoveryNotice">
      <span class="ui zh"
        >这是忘记密码时唯一的自助恢复凭据，只显示这一次。请保存到密码管理器、备忘录或离线文件，不要发送给他人。</span
      >
      <span class="ui en"
        >This is your only self-service recovery credential if you forget your
        password. It is shown once. Store it safely and never share it.</span
      >
    </p>
    <code data-testid="recovery-key">{{ recoveryKey }}</code>
    <div class="actionBtnContainer">
      <button type="button" data-testid="copy-recovery-key" @click="copyKey">
        <span class="ui zh">复制</span><span class="ui en">Copy</span>
      </button>
      <button
        type="button"
        data-testid="download-recovery-key"
        @click="downloadKey"
      >
        <span class="ui zh">下载 TXT</span
        ><span class="ui en">Download TXT</span>
      </button>
    </div>
    <label class="recoveryConfirmation">
      <input v-model="confirmed" type="checkbox" />
      <span class="ui zh">我已妥善保存恢复密钥</span
      ><span class="ui en">I have saved the recovery key</span>
    </label>
    <button
      class="okBtn"
      data-testid="confirm-recovery-key"
      :disabled="!confirmed"
      @click="finish"
    >
      <span class="ui zh">继续 →</span><span class="ui en">Continue →</span>
    </button>
  </div>
</template>

<style scoped>
.recoveryKeyPopup {
  width: 28rem;
  max-width: 78vw;
}

.recoveryNotice {
  line-height: 1.6;
  color: #333;
}

code {
  display: block;
  box-sizing: border-box;
  margin: 1rem 0;
  padding: 0.875rem;
  overflow-wrap: anywhere;
  border: 1px solid rgba(0, 0, 0, 0.25);
  background: rgba(255, 255, 255, 0.55);
  font-family: Consolas, 'Courier New', monospace;
  font-size: 1.05rem;
  line-height: 1.5;
  text-align: center;
  user-select: all;
}

.recoveryConfirmation {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1rem 0;
  font-size: 0.875rem;
}
</style>
