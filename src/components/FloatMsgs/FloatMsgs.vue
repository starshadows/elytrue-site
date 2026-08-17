<template>
  <div
    v-for="item in FloatMsgs.messages"
    :key="item.id"
    :ref="`msg-${item.id}`"
    :class="{
      'float-msg': true,
      [item.type]: true,
      persist: item.persist,
      closing: item.closing,
    }"
    @touchstart="touchStart($event, item.id)"
    @touchmove.prevent="touchMove($event, item.id)"
    @touchend="touchEnd($event, item.id)"
  >
    <i v-if="item.type == 'info'">💡</i>
    <i v-if="item.type == 'success'">✅</i>
    <i v-if="item.type == 'warn'">⚠️</i>
    <i v-if="item.type == 'error'">❌</i>
    <span v-html="item.msg"></span>
    <i
      v-if="item.persist"
      class="closeBtn"
      @click="FloatMsgs.close(item.id)"
    ></i>
  </div>
</template>

<script setup lang="ts">
import { nextTick } from 'vue'
import FloatMsgs from './index'

interface SwipeState {
  element: HTMLDivElement
  startTime: number
  startX: number
  x: number
}

const swipes = new Map<number, SwipeState>()

function touchStart(event: TouchEvent, id: number): void {
  const touch = event.touches[0]
  const element = event.currentTarget
  if (!touch || !(element instanceof HTMLDivElement)) return
  swipes.set(id, {
    element,
    startTime: event.timeStamp,
    startX: touch.clientX,
    x: 0,
  })
}

function touchMove(event: TouchEvent, id: number): void {
  const swipe = swipes.get(id)
  const touch = event.touches[0]
  if (!swipe || !touch) return
  swipe.x = touch.clientX - swipe.startX
  swipe.element.style.transform = `translate(${swipe.x}px)`
  swipe.element.style.opacity = String(
    1 - Math.abs(swipe.x) / swipe.element.clientWidth,
  )
}

function touchEnd(event: TouchEvent, id: number): void {
  const swipe = swipes.get(id)
  if (!swipe) return
  swipes.delete(id)
  const elapsed = Math.max(1, event.timeStamp - swipe.startTime)
  if (
    Math.abs(swipe.x) > swipe.element.clientWidth / 2 ||
    Math.abs(swipe.x) / elapsed > 0.5
  ) {
    void nextTick(() => {
      swipe.element.style.transform = `translate(${swipe.x < 0 ? '-' : ''}100%)`
      swipe.element.style.opacity = '0'
      swipe.element.style.animation = 'none'
    })
    FloatMsgs.close(id)
    return
  }
  swipe.element.style.removeProperty('transform')
  swipe.element.style.removeProperty('opacity')
}
</script>

<style>
#floatMsgs {
  top: 15%;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  flex-flow: column;
  pointer-events: none;
}
</style>

<style scoped lang="scss">
.float-msg {
  margin: 0 0 0.75rem;
  padding: 0.5rem 0.75rem;
  background-color: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(0.5rem);
  border-radius: 0.5rem;
  box-sizing: border-box;
  max-width: 80vw;
  display: flex;
  flex-flow: row;
  gap: 0.5rem;
  align-items: center;
  box-shadow: 0 0.125rem 0.5rem 0 rgba(0, 0, 0, 0.5);
  animation: floatMsgFlyin 0.3s;

  &.success {
    background-color: rgba(200, 255, 200, 0.75);
  }

  &.warn {
    background-color: rgba(255, 255, 200, 0.75);
  }

  &.error {
    background-color: rgba(255, 200, 200, 0.75);
  }

  &.persist {
    pointer-events: all;
  }

  &.closing {
    animation: floatMsgClose 0.2s forwards;
    transition:
      margin-bottom 0.3s cubic-bezier(0.15, 0.7, 0.2, 0.9),
      transform 0.2s,
      opacity 0.2s;
    pointer-events: none;
  }

  .lowend &.closing {
    display: none;
  }

  & > i {
    user-select: none;
    font-style: normal;
    flex-shrink: 0;
  }

  & > span {
    min-width: 0;
  }

  & .closeBtn {
    display: block;
    width: 0.825em;
    height: 0.825em;
    line-height: 0.625em;
    font-size: 1.6rem;
    font-family: Arial;
    box-sizing: border-box;
    padding: 0.125em;
    border: none;
    background-color: rgba(0, 0, 0, 0.1);
    border-radius: 100%;
  }

  & .closeBtn::after {
    content: '\00D7';
  }

  & .closeBtn:hover {
    background-color: rgba(0, 0, 0, 0.3);
  }

  & .closeBtn:active {
    background-color: rgba(0, 0, 0, 0.5);
  }

  @keyframes floatMsgFlyin {
    from {
      opacity: 0;
      transform: translateY(-50%);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes floatMsgClose {
    from {
      opacity: 1;
      transform: scale(1);
    }

    to {
      opacity: 0;
      transform: scale(0.9);
    }
  }
}
</style>
