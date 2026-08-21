<script setup lang="ts">
import { ref } from 'vue'
import Popups from './Popups'
import { changeLang } from '../settings/lang'
import { setConfig } from '../settings/config'

const emit = defineEmits<{ install: [] }>()
const open = ref(false)

function setLanguage(language: '' | 'zh' | 'en'): void {
  changeLang(language)
  setConfig('lang', language)
  open.value = false
}

function showPopup(
  name: 'themeSelectorPopup' | 'displaySettings' | 'getImgPopup',
): void {
  open.value = false
  Popups.show(name)
}

function install(): void {
  open.value = false
  emit('install')
}
</script>

<template>
  <div id="siteControls" class="siteControls">
    <div id="toolbar">
      <div
        id="menu"
        class="toolbarItem"
        :class="{ open }"
        role="button"
        tabindex="0"
        :aria-expanded="open"
        @click="open = !open"
        @keydown.enter.prevent="open = !open"
        @keydown.space.prevent="open = !open"
      >
        <span class="ui zh">工具 🛠</span><span class="ui en">Tools 🛠</span>
        <ul @click.stop>
          <li @click="showPopup('themeSelectorPopup')">
            <span class="ui zh">🖌️ 主题&音乐设置</span
            ><span class="ui en">🖌️ Themes & Music</span>
          </li>
          <li @click="showPopup('displaySettings')">
            <span class="ui zh">🖥️ 显示设置</span
            ><span class="ui en">🖥️ Display settings</span>
          </li>
          <li @click="showPopup('getImgPopup')">
            <span class="ui zh">💾 保存背景图片</span
            ><span class="ui en">💾 Download backgrounds</span>
          </li>
          <li @click="install">
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
        </ul>
      </div>
    </div>
  </div>
</template>
