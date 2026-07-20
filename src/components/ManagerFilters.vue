<script setup lang="ts">
import { translate, type Locale } from '../i18n'
import type { ClipKind } from '../domain/clipboard'

const props = defineProps<{
  kinds: ClipKind[]
  locale: Locale
}>()

const emit = defineEmits<{
  'update:kinds': [value: ClipKind[]]
}>()

const kindOptions: ClipKind[] = ['text', 'code', 'link', 'image', 'file']
const t = (key: Parameters<typeof translate>[1]) => translate(props.locale, key)

function toggleKind(kind: ClipKind) {
  emit('update:kinds', props.kinds.includes(kind)
    ? props.kinds.filter((candidate) => candidate !== kind)
    : kindOptions.filter((candidate) => candidate === kind || props.kinds.includes(candidate)))
}
</script>

<template>
  <nav class="manager-filters" data-testid="manager-filters" :aria-label="t('managerFilterKind')">
    <button
      data-testid="manager-kind-all"
      type="button"
      :aria-pressed="kinds.length === 0"
      :class="{ active: kinds.length === 0 }"
      @click="emit('update:kinds', [])"
    >
      {{ t('all') }}
    </button>
    <button
      v-for="kind in kindOptions"
      :key="kind"
      :data-testid="`manager-kind-${kind}`"
      type="button"
      :aria-pressed="kinds.includes(kind)"
      :class="{ active: kinds.includes(kind) }"
      @click="toggleKind(kind)"
    >
      {{ t(kind) }}
    </button>
  </nav>
</template>
