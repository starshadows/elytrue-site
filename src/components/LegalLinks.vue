<script setup lang="ts">
import { SITE } from '../config/site'
</script>

<template>
  <nav class="legalLinks siteLegalLinks" aria-label="网站备案信息">
    <a :href="SITE.icp.url" target="_blank" rel="noopener noreferrer">{{
      SITE.icp.label
    }}</a>
    <a
      :href="SITE.publicSecurity.url"
      target="_blank"
      rel="noopener noreferrer"
    >
      <img :src="SITE.publicSecurity.icon" alt="" />
      <span>{{ SITE.publicSecurity.label }}</span>
    </a>
  </nav>
</template>
