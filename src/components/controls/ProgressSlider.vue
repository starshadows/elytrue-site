<template>
    <div class="progress-slider" :style="{ '--height': typeof height == 'number' ? `${height}px` : height }" @pointerdown="pointerDownHandler" @pointerup="pointerUpHandler">
        <div class="progress" :style="{ width: `${displayPercentage}%` }"></div>
        <input ref="slider" type="range" :min="min ?? 0" :max="max ?? 1" :step="step ?? 0.001">
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

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
const displayPercentage = ref(0)

function updateDisplayPercentage(value: number | undefined) {
    value = value != null
        ? (value - parseFloat(slider.value!.min)) / (parseFloat(slider.value!.max) - parseFloat(slider.value!.min)) * 100
        : 0
    if (value > 100) value = 100
    if (value < 0) value = 0
    displayPercentage.value = value
}

onMounted(() => {
    slider.value!.onchange = () => {
        progress.value = parseFloat(slider.value!.value)
        // console.log('internal value update:', progress.value)
        onChange && onChange(progress.value)
    }

    slider.value!.oninput = () => {
        updateDisplayPercentage(parseFloat(slider.value!.value))
    }
})

watch(progress, () => {
    if (progress.value != parseFloat(slider.value!.value)) {
        // console.log('external value update:', progress.value)
        if (!pointerDown) {
            slider.value!.value = progress.value?.toString() ?? min?.toString() ?? '0'
            updateDisplayPercentage(progress.value)
        }
    }
})

function pointerDownHandler() {
    // console.log('pointer down')
    pointerDown = true
}

function pointerUpHandler() {
    // console.log('pointer up')
    pointerDown = false
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
            content: "";
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