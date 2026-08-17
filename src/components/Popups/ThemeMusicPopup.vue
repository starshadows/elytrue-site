<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import Popups from './index'
import { themeControllerKey } from '../../features/theme/theme-controller'
import {
  DESKTOP_THEME_SELECTIONS,
  MOBILE_THEME_SELECTIONS,
  imageThemeForSelection,
  videoThemeForSelection,
  type MediaTheme,
  type ThemeAudience,
  type ThemeSelectionId,
} from '../../config/assets'
import MusicPlayer from '../MusicPlayer.vue'

const injectedTheme = inject(themeControllerKey)
if (!injectedTheme) throw new Error('Theme controller is not provided')
const theme = injectedTheme
const mobile = ref(window.matchMedia('(max-width: 720px)').matches)
let mediaQuery: MediaQueryList | undefined

function handleLayoutChange(event: MediaQueryListEvent): void {
  mobile.value = event.matches
}

function audience(): ThemeAudience {
  return mobile.value ? 'mobile' : 'desktop'
}

function resolveCard(selection: ThemeSelectionId): MediaTheme {
  const video = videoThemeForSelection(selection)
  if (video) return video
  const image = imageThemeForSelection(selection, audience())
  if (!image) throw new Error(`Theme card is unavailable: ${selection}`)
  return image
}

const cards = computed(() =>
  (mobile.value ? MOBILE_THEME_SELECTIONS : DESKTOP_THEME_SELECTIONS).map(
    resolveCard,
  ),
)

function select(value: ThemeSelectionId): void {
  theme.set(value)
  Popups.close()
}

onMounted(() => {
  mediaQuery = window.matchMedia('(max-width: 720px)')
  mediaQuery.addEventListener('change', handleLayoutChange)
})

onBeforeUnmount(() =>
  mediaQuery?.removeEventListener('change', handleLayoutChange),
)
</script>

<template>
  <div>
    <h2>
      <span class="ui zh">主题 & 音乐</span
      ><span class="ui en">Themes & Music</span>
    </h2>
    <p class="themePopupLinks">
      <span class="underlinedIconLink" @click="Popups.show('displaySettings')">
        <span class="ui zh">🖥️ 显示设置</span
        ><span class="ui en">🖥️ Display settings</span>
      </span>
      <span class="underlinedIconLink" @click="Popups.show('getImgPopup')">
        <span class="ui zh">下载背景图片</span
        ><span class="ui en">Download backgrounds</span>
        <img src="/res/download.svg" />
      </span>
    </p>
    <div id="themeList" :class="{ mobile }">
      <div
        v-for="card in cards"
        :key="card.id"
        :data-theme="card.selection"
        :data-kind="card.kind"
        @click="select(card.selection)"
      >
        <img
          loading="lazy"
          decoding="async"
          :src="card.cardPreview"
          :style="{ objectPosition: card.cardFocus ?? '50% 50%' }"
        />
        <span>
          <span class="ui zh">{{ (card.cardTitle ?? card.title).zh }}</span
          ><span class="ui en">{{ (card.cardTitle ?? card.title).en }}</span>
        </span>
      </div>
    </div>
  </div>
  <MusicPlayer />
</template>
