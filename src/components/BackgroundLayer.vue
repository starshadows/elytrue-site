<script setup lang="ts">
import { IMAGE_THEMES } from '../config/assets'
import VideoPlayerLayer from './VideoPlayerLayer.vue'
import Settings from '../settings'
</script>

<template>
  <div id="bgContainer">
    <template v-for="theme in IMAGE_THEMES" :key="theme.id">
      <div
        v-for="background in theme.backgrounds"
        :key="`${theme.id}:${background.id}`"
        class="mainbg"
        :data-theme-id="theme.id"
        :data-background-id="background.id"
        :data-layout="background.layout"
        :data-src="background.preview.slice(1)"
        :data-original="background.original.slice(1)"
        :data-credit-url="background.creditUrl"
      >
        <div :style="{ backgroundPosition: background.focus }"></div>
      </div>
    </template>

    <template v-for="theme in IMAGE_THEMES" :key="`credit:${theme.id}`">
      <template
        v-for="background in theme.backgrounds"
        :key="`credit:${theme.id}:${background.id}`"
      >
        <a
          v-if="background.creditUrl"
          class="backgroundCredit"
          :data-theme-id="theme.id"
          :data-background-id="background.id"
          :data-credit-url="background.creditUrl"
          :href="background.creditUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="backgroundCreditText">
            <span class="ui zh">{{ background.credit.zh }}</span>
            <span class="ui en">{{ background.credit.en }}</span>
          </span>
        </a>
        <span
          v-else
          class="backgroundCredit"
          :data-theme-id="theme.id"
          :data-background-id="background.id"
        >
          <span class="backgroundCreditText">
            <span class="ui zh">{{ background.credit.zh }}</span>
            <span class="ui en">{{ background.credit.en }}</span>
          </span>
        </span>
      </template>
    </template>

    <div class="videoBackgroundBlur" aria-hidden="true"></div>

    <div
      v-show="!Settings.hideBackgroundCaptions"
      id="mainCaptions"
      style="opacity: 0"
    >
      <div class="defaultCaption">
        <p>云想衣裳花想容，</p>
        <p>春风拂槛露华浓。</p>
      </div>
      <div class="defaultCaption">
        <p>愿我如星君如月，</p>
        <p>夜夜流光相皎洁。</p>
      </div>
      <div class="defaultCaption" data-sequence-group="elysia-origin">
        <p>星月落下，编织温柔的童话。</p>
        <p>大地丰饶，养育初生的新芽。</p>
        <p>无瑕的少女自人群间穿行，将人之美尽收眼底。</p>
      </div>
      <div class="defaultCaption" data-sequence-group="elysia-origin">
        <p>真我的英桀在末世中起舞，将善与爱贯彻始终。</p>
        <p>人类的律者化作新生的种子，在细枝上绽放人性的飞花。</p>
        <p>那花名为爱莉希雅……人之律者，爱莉希雅。</p>
      </div>
      <div class="defaultCaption">
        <p>此后，将有群星闪耀，因为我如今来过。</p>
        <p>此后，将有百花绽放，因为我从未离去。</p>
      </div>
      <div class="defaultCaption">
        <p>愿你前行的道路有群星闪耀。</p>
        <p>愿你留下的足迹有百花绽放。</p>
        <p>你即是上帝的馈赠，世界因你而瑰丽。</p>
      </div>
      <div class="defaultCaption">
        <p>执拗的花朵永远不会因暴雨而褪去颜色，</p>
        <p>你的决心也一定能在绝境中绽放真我。</p>
      </div>
    </div>
  </div>
  <Teleport to="body">
    <VideoPlayerLayer />
  </Teleport>
</template>
