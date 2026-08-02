<template>
  <div>
    <h2 v-html="title"></h2>
    <div v-html="subtitle" class="inputHelperText"></div>
    <input
      type="text"
      v-model="value"
      @keypress="(e) => e.key == 'Enter' && value.length > 0 && submit()"
    />
    <button
      class="okBtn"
      :disabled="value.length == 0 || disabled"
      @click="submit()"
    >
      <span class="ui zh">确定 ✔</span><span class="ui en">OK ✔</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface InputActionContext {
  close: () => void
  setDisabled: (value: boolean) => void
}

const props = defineProps<{
  title: string
  subtitle?: string
  text?: string
  action?: (value: string, context: InputActionContext) => void
}>()
const emit = defineEmits<{ close: [] }>()

const value = ref(props.text ?? '')
const disabled = ref(false)

function submit(): void {
  const context: InputActionContext = {
    close: () => emit('close'),
    setDisabled: (nextValue) => {
      disabled.value = nextValue
    },
  }
  if (props.action) props.action(value.value, context)
  else context.close()
}
</script>
