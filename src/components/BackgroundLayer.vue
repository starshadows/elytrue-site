<script setup lang="ts">
import { BACKGROUNDS } from '../config/assets'
</script>

<template>
  <div id="bgContainer">
    <div
      v-for="background in BACKGROUNDS"
      :key="background.id"
      class="mainbg defaultbg"
      :data-background-id="background.id"
      :data-layout="background.layout"
      :data-src="background.preview"
      :data-original="background.original"
      :data-credit-url="background.creditUrl"
    >
      <div :style="{ backgroundPosition: background.focus }"></div>
      <span>
        <span class="ui zh">{{ background.credit.zh }}</span>
        <span class="ui en">{{ background.credit.en }}</span>
      </span>
    </div>

    <div id="mainCaptions" style="opacity: 0">
      <div class="defaultCaption">
        <p>云想衣裳花想容，</p>
        <p>春风拂槛露华浓。</p>
        <p class="captionSource">—— 李白《清平调》</p>
      </div>
      <div class="defaultCaption">
        <p>愿我如星君如月，</p>
        <p>夜夜流光相皎洁。</p>
        <p class="captionSource">—— 范成大《车遥遥篇》</p>
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
</template>
