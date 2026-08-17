<script setup lang="ts">
import Settings from '../settings'
</script>

<template>
  <div v-show="Settings.showTimeline" id="timelineContainer">
    <div id="timeline">
      <p><strong>2026</strong><span>8</span></p>
    </div>
    <div id="hoverCalendar" style="display: none"></div>
  </div>
</template>
