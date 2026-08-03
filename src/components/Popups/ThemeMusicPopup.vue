<script setup lang="ts">
import { inject } from 'vue'
import Popups from './index'
import { themeControllerKey } from '../../features/theme/theme-controller'
import MusicPlayer from '../MusicPlayer.vue'

const injectedTheme = inject(themeControllerKey)
if (!injectedTheme) throw new Error('Theme controller is not provided')
const theme = injectedTheme

function select(value: string): void {
  theme.set(value)
  Popups.close()
}
</script>

<template>
  <div>
    <h2>
      <span class="ui zh">主题 & 音乐</span
      ><span class="ui en">Themes & Music</span>
    </h2>
    <p style="width: 100%">
      <span class="underlinedIconLink" @click="Popups.show('displaySettings')">
        <span class="ui zh">🖥️ 显示设置</span
        ><span class="ui en">🖥️ Display settings</span>
      </span>
      <span
        class="underlinedIconLink"
        style="float: right; padding-left: 4px"
        @click="Popups.show('getImgPopup')"
      >
        <span class="ui zh">下载背景图片</span
        ><span class="ui en">Download backgrounds</span>
        <img src="/res/download.svg" />
      </span>
    </p>
    <div id="themeList">
      <div data-theme="" @click="select('')">
        <img
          loading="lazy"
          src="/res/auto_theme.jpg"
          style="border: 0.5rem solid white"
        />
        <span
          ><span class="ui zh">自动</span><span class="ui en">Auto</span></span
        >
      </div>
      <div data-theme="default" @click="select('default')">
        <img loading="lazy" src="/assets/elytrue-20260724/bg/landscape1.webp" />
        <span
          ><span class="ui zh">爱莉希雅</span
          ><span class="ui en">Elysia</span></span
        >
      </div>
    </div>
  </div>
  <MusicPlayer />
</template>
