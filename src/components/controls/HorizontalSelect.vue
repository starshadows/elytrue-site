<template>
    <div class="horizontal-select">
        <button v-for="[key, value] in Object.entries(props.options)" v-html="key" :class="{ selected: selected == value }" @click="selected = value"></button>
    </div>
</template>

<script setup lang="ts">
const props = defineProps<{
    options: Record<string, unknown>
}>()
const selected = defineModel<unknown>()

</script>

<style scoped lang="scss">
.horizontal-select {
    display: flex;
    background-color: #613e74;
    border-radius: 0.375em;
    overflow: hidden;

    >button {
        border: none;
        background: none;
        display: flex;
        align-items: center;
        font-size: 0.9em;
        padding: 0 0.675em;
        color: white;
        transition: background-color 0.15s;

        &.selected {
            background-color: #f595be;
        }
    }
}
</style>