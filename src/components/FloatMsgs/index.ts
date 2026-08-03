import { reactive, readonly } from 'vue'

export interface FloatMessageOptions {
  type: 'info' | 'success' | 'warn' | 'error'
  msg: string
  persist?: boolean
  timeout?: number
}

export interface FloatMessage extends FloatMessageOptions {
  id: number
  closing: boolean
}

const messages = reactive<FloatMessage[]>([])
let nextId = 0

function close(id: number): void {
  const message = messages.find((item) => item.id === id)
  if (!message || message.closing) return
  message.closing = true
  window.setTimeout(() => {
    const index = messages.findIndex((item) => item.id === id)
    if (index >= 0) messages.splice(index, 1)
  }, 500)
}

function show(value: FloatMessageOptions | string): void {
  const options: FloatMessageOptions =
    typeof value === 'string' ? { type: 'info', msg: value } : value
  const message = reactive<FloatMessage>({
    ...options,
    id: nextId++,
    closing: false,
  })
  messages.push(message)
  if (!message.persist) {
    window.setTimeout(() => close(message.id), message.timeout ?? 4_000)
  }
}

export default {
  close,
  messages: readonly(messages),
  show,
}
