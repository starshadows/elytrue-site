<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    src: string
    alt?: string
    loading?: 'eager' | 'lazy'
  }>(),
  { alt: '', loading: 'lazy' },
)

const displayedSrc = ref(props.src)
let loadVersion = 0
let pendingImage: HTMLImageElement | undefined

async function commitLoadedImage(
  image: HTMLImageElement,
  source: string,
  version: number,
): Promise<void> {
  try {
    if (image.decode) await image.decode()
  } catch {
    // The load event is still a valid decoded-enough fallback.
  }
  if (version === loadVersion && props.src === source)
    displayedSrc.value = source
}

function loadSource(source: string): void {
  loadVersion += 1
  const version = loadVersion
  pendingImage = undefined
  if (!displayedSrc.value) {
    displayedSrc.value = source
    return
  }
  if (source === displayedSrc.value) return
  const image = new Image()
  pendingImage = image
  image.onload = () => void commitLoadedImage(image, source, version)
  image.onerror = () => {
    if (version === loadVersion) pendingImage = undefined
  }
  image.src = source
}

watch(() => props.src, loadSource, { immediate: true })

onBeforeUnmount(() => {
  loadVersion += 1
  if (pendingImage) {
    pendingImage.onload = null
    pendingImage.onerror = null
  }
  pendingImage = undefined
})
</script>

<template>
  <img :src="displayedSrc" :alt="alt" :loading="loading" />
</template>
