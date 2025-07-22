<template>
    <HorizontalSelect :options="graphicsModeOptions" v-model="graphicsMode"></HorizontalSelect>
</template>

<script setup lang="ts">
import HorizontalSelect from './controls/HorizontalSelect.vue'
import { ref, watch } from 'vue'
import Settings from '../settings'

const graphicsMode = ref(Settings.graphicsMode)
const graphicsModeOptions = {
    '<span class="ui zh">流畅</span><span class="ui en">Fast</span>': 'low',
    '<span class="ui zh">中等</span><span class="ui en">Balanced</span>': 'mid',
    '<span class="ui zh">极高</span><span class="ui en">Fancy</span>': 'high',
}

watch(graphicsMode, () => {
    Settings.graphicsMode = graphicsMode.value
})
</script>
