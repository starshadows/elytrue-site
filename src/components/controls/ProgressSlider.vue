<template>
  <div
    class="progress-slider"
    :style="{ '--height': typeof height == 'number' ? `${height}px` : height }"
    @pointerdown="pointerDownHandler"
    @pointerup="pointerUpHandler"
    @pointercancel="pointerCancelHandler"
    @lostpointercapture="pointerCancelHandler"
    @touchstart="touchStartHandler"
    @touchmove.prevent="touchMoveHandler"
    @touchend="touchEndHandler"
    @touchcancel="touchCancelHandler"
  >
    <div class="progress" :style="{ width: `${displayPercentage}%` }"></div>
    <input
      ref="slider"
      type="range"
      :min="min ?? 0"
      :max="max ?? 1"
      :step="step ?? 0.001"
      @input="inputHandler"
      @change="changeHandler"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

const { min, onChange } = defineProps<{
  min?: number
  max?: number
  step?: number
  height?: number | string
  onChange?: (progress: number) => void
}>()
const progress = defineModel<number>()

defineExpose({ progress })

const slider = ref<HTMLInputElement>()

let pointerDown = false
let touchIdentifier: number | undefined
let suppressNativeChange = false
const displayPercentage = ref(0)

function updateDisplayPercentage(value: number | undefined) {
  const element = slider.value
  if (!element) return
  const minimum = Number(element.min)
  const maximum = Number(element.max)
  const range = maximum - minimum
  const percentage =
    value != null &&
    Number.isFinite(value) &&
    Number.isFinite(minimum) &&
    Number.isFinite(maximum) &&
    range > 0
      ? ((value - minimum) / range) * 100
      : 0
  displayPercentage.value = Math.min(100, Math.max(0, percentage))
}

onMounted(() => {
  syncFromProgress()
})

watch(progress, () => {
  if (!pointerDown) syncFromProgress()
})

function syncFromProgress(): void {
  const element = slider.value
  if (!element) return
  const value = progress.value
  if (value != null && Number.isFinite(value)) {
    element.value = value.toString()
  } else {
    element.value = min?.toString() ?? '0'
  }
  updateDisplayPercentage(Number(element.value))
}

function inputHandler(event: Event): void {
  const value = Number((event.currentTarget as HTMLInputElement).value)
  if (Number.isFinite(value)) updateDisplayPercentage(value)
}

function changeHandler(event: Event): void {
  if (touchIdentifier !== undefined) return
  if (suppressNativeChange) {
    suppressNativeChange = false
    return
  }
  const value = Number((event.currentTarget as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  commitValue(value)
}

function commitValue(value: number): void {
  progress.value = value
  updateDisplayPercentage(value)
  onChange?.(value)
}

function pointerDownHandler(): void {
  pointerDown = true
}

function pointerUpHandler(): void {
  if (touchIdentifier === undefined) pointerDown = false
}

function pointerCancelHandler(): void {
  if (touchIdentifier !== undefined) return
  pointerDown = false
  syncFromProgress()
}

function findTouch(touches: TouchList): Touch | undefined {
  if (touchIdentifier === undefined) return undefined
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index)
    if (touch?.identifier === touchIdentifier) return touch
  }
  return undefined
}

function updateFromTouch(touch: Touch): number | undefined {
  const element = slider.value
  if (!element) return undefined
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0) return undefined
  const minimum = Number(element.min)
  const maximum = Number(element.max)
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return undefined
  const ratio = Math.min(
    1,
    Math.max(0, (touch.clientX - bounds.left) / bounds.width),
  )
  element.value = String(minimum + (maximum - minimum) * ratio)
  const value = Number(element.value)
  if (!Number.isFinite(value)) return undefined
  updateDisplayPercentage(value)
  return value
}

function touchStartHandler(event: TouchEvent): void {
  if (event.touches.length !== 1) return
  const touch = event.touches.item(0)
  if (!touch) return
  touchIdentifier = touch.identifier
  suppressNativeChange = false
  pointerDown = true
  updateFromTouch(touch)
}

function touchMoveHandler(event: TouchEvent): void {
  const touch = findTouch(event.touches)
  if (touch) updateFromTouch(touch)
}

function touchEndHandler(event: TouchEvent): void {
  const touch = findTouch(event.changedTouches)
  const value = touch ? updateFromTouch(touch) : undefined
  touchIdentifier = undefined
  pointerDown = false
  suppressNativeChange = true
  window.setTimeout(() => (suppressNativeChange = false), 0)
  if (value === undefined) syncFromProgress()
  else commitValue(value)
}

function touchCancelHandler(): void {
  touchIdentifier = undefined
  suppressNativeChange = false
  pointerDown = false
  syncFromProgress()
}
</script>

<style scoped lang="scss">
.progress-slider {
  position: relative;
  width: 5rem;
  --height: 0.375rem;
  height: var(--height);
  padding: 0 calc(var(--height) * 5 / 6);
  box-sizing: border-box;
  background-color: rgba(0, 0, 0, 0.2);

  .progress {
    position: relative;
    height: 100%;
    background-color: #ff9cba;
    margin-left: calc(var(--height) * 5 / 6 * (-1));
    border-left: calc(var(--height) * 5 / 6) solid #ff9cba;

    &::after {
      content: '';
      position: absolute;
      right: 0;
      top: 50%;
      transform: translate(50%, -50%);
      width: calc(var(--height) * 10 / 6);
      height: calc(var(--height) * 10 / 6);
      border-radius: 100%;
      background-color: inherit;
      filter: brightness(0.95);
    }
  }

  &:hover {
    .progress::after {
      width: calc(var(--height) * 12 / 6);
      height: calc(var(--height) * 12 / 6);
    }
  }

  input {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
  }
}
</style>
