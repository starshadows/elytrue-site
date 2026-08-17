<script setup lang="ts">
import { ref } from 'vue'
import Popups from './Popups'
import { commentsStore } from '../features/comments/comments-store'
import { changeLang } from '../settings/lang'
import { setConfig } from '../settings/config'
import FloatMsgs from './FloatMsgs'

const emit = defineEmits<{
  fullscreen: []
  install: []
  newComment: []
}>()
const goto = ref('')
const refreshing = ref(false)

function setLanguage(language: '' | 'zh' | 'en'): void {
  changeLang(language)
  setConfig('lang', language)
}

function gotoComment(): void {
  if (goto.value)
    void commentsStore.gotoNumber(goto.value).catch(() => undefined)
}

async function refreshComments(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await Promise.all([
      commentsStore.refresh(),
      new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
    ])
  } catch {
    FloatMsgs.show({
      type: 'error',
      msg: '<span class="ui zh">刷新留言失败</span><span class="ui en">Failed to refresh messages</span>',
    })
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <div id="newMsgContainer" class="backTransparent">
    <button id="newMsg" @click="emit('newComment')">
      <span class="ui zh">➕ 发送留言</span
      ><span class="ui en">➕ New message</span>
    </button>
  </div>
  <div id="toolbarContainer" class="backTransparent">
    <div id="toolbar">
      <div id="menu" class="toolbarItem">
        <span class="ui zh">工具 🛠</span><span class="ui en">Tools 🛠</span>
        <ul>
          <li
            class="refreshCommentsAction"
            :class="{ refreshing }"
            :aria-busy="refreshing"
            @click="refreshComments"
          >
            <span class="ui zh"
              ><i class="refreshIcon" aria-hidden="true">🔄</i> 刷新</span
            ><span class="ui en"
              ><i class="refreshIcon" aria-hidden="true">🔄</i> Refresh</span
            >
          </li>
          <li @click="Popups.show('themeSelectorPopup')">
            <span class="ui zh">🖌️ 主题&音乐设置</span
            ><span class="ui en">🖌️ Themes & Music</span>
          </li>
          <li @click="Popups.show('displaySettings')">
            <span class="ui zh">🖥️ 显示设置</span
            ><span class="ui en">🖥️ Display settings</span>
          </li>
          <li @click="Popups.show('getImgPopup')">
            <span class="ui zh">💾 保存背景图片</span
            ><span class="ui en">💾 Download backgrounds</span>
          </li>
          <li @click="emit('install')">
            <span class="ui zh">📲 安装App到桌面</span
            ><span class="ui en">📲 Install as App</span>
          </li>
          <li>
            <span>🌎 Language (语言)</span><i></i>
            <ul>
              <li @click="setLanguage('')">
                <span class="ui zh">(自动)</span
                ><span class="ui en">(Auto)</span>
              </li>
              <li @click="setLanguage('en')"><span>English</span></li>
              <li @click="setLanguage('zh')"><span>中文</span></li>
            </ul>
          </li>
          <li>
            <span class="ui zh">跳转到留言(#ID)</span
            ><span class="ui en">Go to message (#ID)</span>
            <span style="display: inline-flex; align-items: center; padding: 0"
              ><input
                id="goto"
                v-model="goto"
                style="width: 4rem"
                @keydown.enter.prevent="gotoComment"
              /><button @click="gotoComment">Go</button></span
            >
          </li>
        </ul>
      </div>
      <button
        id="fullscreenBtn"
        class="toolbarItem"
        @click="emit('fullscreen')"
      >
        <span class="ui zh">竖屏 ↕</span><span class="ui en">Expand ↕</span>
      </button>
    </div>
  </div>
</template>
