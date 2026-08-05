<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const DEFAULT_AVATAR = '/res/defaultAvatar.png'

const props = withDefaults(
  defineProps<{
    src: string
    fallbackSrc?: string
    alt?: string
    loading?: 'eager' | 'lazy'
    fetchpriority?: 'high' | 'low' | 'auto'
  }>(),
  {
    fallbackSrc: DEFAULT_AVATAR,
    alt: '',
    loading: 'lazy',
    fetchpriority: 'auto',
  },
)

const fallback = computed(() => props.fallbackSrc.trim() || DEFAULT_AVATAR)
const targetSource = computed(() => props.src.trim() || fallback.value)
const isDynamicAvatar = (source: string): boolean =>
  source.includes('/api/data/images/avatars/')
const displayedSrc = ref(
  isDynamicAvatar(targetSource.value) ? fallback.value : targetSource.value,
)
let loadVersion = 0
let pendingImage: HTMLImageElement | undefined
let pendingSource = ''
let unmounted = false

function clearPendingImage(): void {
  if (pendingImage) {
    pendingImage.onload = null
    pendingImage.onerror = null
  }
  pendingImage = undefined
  pendingSource = ''
}

async function commitLoadedAvatar(
  image: HTMLImageElement,
  source: string,
  version: number,
): Promise<void> {
  try {
    await image.decode()
  } catch {
    if (!image.complete || image.naturalWidth <= 0) {
      if (version === loadVersion) clearPendingImage()
      return
    }
  }
  if (unmounted || version !== loadVersion || targetSource.value !== source)
    return
  clearPendingImage()
  displayedSrc.value = source
}

function loadSource(source: string): void {
  if (source === displayedSrc.value || source === pendingSource) return

  const version = ++loadVersion
  clearPendingImage()
  if (!isDynamicAvatar(source)) {
    displayedSrc.value = source
    return
  }

  const image = new Image()
  pendingImage = image
  pendingSource = source
  image.onload = () => void commitLoadedAvatar(image, source, version)
  image.onerror = () => {
    if (version === loadVersion) clearPendingImage()
  }
  image.src = source
}

watch(targetSource, loadSource, { immediate: true })

onBeforeUnmount(() => {
  unmounted = true
  loadVersion += 1
  clearPendingImage()
})
</script>

<template>
  <img
    class="stableAvatar"
    :src="displayedSrc"
    :alt="alt"
    :loading="loading"
    :fetchpriority="fetchpriority"
  />
</template>
