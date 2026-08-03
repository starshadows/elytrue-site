<script setup lang="ts">
import { BACKGROUNDS, BACKGROUND_GROUPS } from '../../config/assets'

function loaded(event: Event): void {
  if (event.currentTarget instanceof HTMLImageElement) {
    event.currentTarget.style.removeProperty('min-height')
  }
}
</script>

<template>
  <div>
    <h2>
      <span class="ui zh">保存背景图片</span
      ><span class="ui en">Download backgrounds</span>
    </h2>
    <div class="artPermissionNotice">
      <p>
        <span class="ui zh"
          >本站展示的二创图片均经原作者许可转载，并按作者要求标注画师与来源链接。</span
        >
        <span class="ui en"
          >Fan artworks displayed here are reposted with their artists'
          permission, with artist names and source links credited as
          requested.</span
        >
      </p>
      <p>
        <span class="ui zh"
          >感谢画师 nami、roena、合悟昂、喵咕君QAQ(KH3) 的创作与许可。</span
        >
        <span class="ui en"
          >Special thanks to nami, roena, 合悟昂, and 喵咕君QAQ(KH3) for their
          artwork and permission.</span
        >
      </p>
    </div>
    <h4>
      <span class="ui zh"
        >预览使用轻量
        WebP；点击每张图片下方的“下载原图”获取未经压缩的原文件</span
      >
      <span class="ui en"
        >Previews use lightweight WebP. Use "Download original" below each image
        for the source file.</span
      >
    </h4>
    <template v-for="group in BACKGROUND_GROUPS" :key="group.layout">
      <h3 class="backgroundGroupTitle">
        <span class="ui zh">{{ group.title.zh }}</span
        ><span class="ui en">{{ group.title.en }}</span>
      </h3>
      <template
        v-for="background in BACKGROUNDS.filter(
          (item) => item.layout === group.layout,
        )"
        :key="background.id"
      >
        <img
          loading="lazy"
          decoding="async"
          :src="background.preview"
          style="min-height: 40vh"
          @load="loaded"
        />
        <p>
          <span v-if="background.creditUrl" class="authorizedRepost">
            <span class="ui zh">经作者许可转载</span
            ><span class="ui en">Reposted with permission</span> ·
          </span>
          <span class="ui zh">{{ background.credit.zh }}</span
          ><span class="ui en">{{ background.credit.en }}</span>
          <a
            v-if="background.creditUrl"
            :href="background.creditUrl"
            target="_blank"
            rel="noopener noreferrer"
            >图源↗</a
          >
          <a class="downloadOriginal" :href="background.original" download>
            <span class="ui zh">下载原图</span
            ><span class="ui en">Download original</span> ↓
          </a>
        </p>
        <br />
      </template>
    </template>
  </div>
</template>
