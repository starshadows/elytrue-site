<script setup lang="ts">
import { computed } from 'vue'
import Popups from './Popups'
import { themeState } from '../features/theme/theme-controller'
import { mediaThemeTitle } from '../config/assets'

const currentThemeTitle = computed(() => mediaThemeTitle(themeState.theme))
const homeUrl = `${window.location.origin}${window.location.pathname}`
</script>

<template>
  <header id="header">
    <div id="mainTitle">
      <a :href="homeUrl">
        <span style="color: #ff80c0">星花</span>
        <span style="color: #c074ff">札记</span>
      </a>
    </div>
    <br />
    <div
      class="mainTitleUnder"
      role="button"
      tabindex="0"
      @click="Popups.show('themeSelectorPopup')"
      @keydown.enter="Popups.show('themeSelectorPopup')"
      @keydown.space.prevent="Popups.show('themeSelectorPopup')"
    >
      <img class="musicPlayingIndicator" src="/res/music_note.svg" alt="" />
      <div id="themeIndicator">
        <div class="currentSong"></div>
        <span
          ><span class="ui zh">主题:</span
          ><span class="ui en">Theme:</span></span
        >
        <span id="currentTheme">
          <span :id="`themeTxt-${themeState.theme}`" class="visible">
            <span class="ui zh">{{ currentThemeTitle.zh }}</span
            ><span class="ui en">{{ currentThemeTitle.en }}</span>
          </span>
        </span>
      </div>
      <img src="/res/arrow_right.svg" alt="" />
    </div>
  </header>
</template>
