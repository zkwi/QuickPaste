<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  source: string
  icon?: string
  fallbackColor?: string
}>()

const iconFailed = ref(false)
const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

const showIcon = computed(() => Boolean(props.icon?.trim()) && !iconFailed.value)
const fallbackInitial = computed(() => {
  const source = props.source.trim()
  const grapheme = graphemeSegmenter
    ? graphemeSegmenter.segment(source)[Symbol.iterator]().next().value?.segment
    : Array.from(source)[0]
  return grapheme?.toLocaleUpperCase() ?? '?'
})
const fallbackStyle = computed(() => props.fallbackColor
  ? { '--source-app-icon-fallback-color': props.fallbackColor }
  : undefined)

watch(
  () => [props.icon, props.source],
  () => {
    iconFailed.value = false
  },
)
</script>

<template>
  <span class="source-app-icon" :style="fallbackStyle" aria-hidden="true">
    <img
      v-if="showIcon"
      class="source-app-icon-image"
      :src="icon"
      alt=""
      aria-hidden="true"
      draggable="false"
      @error="iconFailed = true"
    />
    <span v-else class="source-app-icon-fallback" data-testid="source-app-icon-fallback">
      {{ fallbackInitial }}
    </span>
  </span>
</template>

<style scoped>
.source-app-icon {
  display: inline-grid;
  width: var(--source-app-icon-size, 12px);
  height: var(--source-app-icon-size, 12px);
  overflow: hidden;
  flex: 0 0 var(--source-app-icon-size, 12px);
  place-items: center;
  border-radius: 4px;
  vertical-align: middle;
}

.source-app-icon-image,
.source-app-icon-fallback {
  width: 100%;
  height: 100%;
}

.source-app-icon-image {
  display: block;
  object-fit: contain;
}

.source-app-icon-fallback {
  display: inline-grid;
  place-items: center;
  color: #fff;
  background: var(--source-app-icon-fallback-color, var(--brand, #4d6fce));
  font-size: calc(var(--source-app-icon-size, 12px) * 0.58);
  font-weight: 750;
  line-height: 1;
}
</style>
