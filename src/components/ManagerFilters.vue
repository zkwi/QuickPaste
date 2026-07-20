<script setup lang="ts">
import { computed } from 'vue'
import { translate, type Locale } from '../i18n'
import type { ClipKind } from '../domain/clipboard'

const props = defineProps<{
  kinds: ClipKind[]
  sourceApp: string
  pinned?: boolean
  locale: Locale
}>()

const emit = defineEmits<{
  'update:kinds': [value: ClipKind[]]
  'update:sourceApp': [value: string]
  'update:pinned': [value: boolean | undefined]
}>()

const kindOptions: ClipKind[] = ['text', 'code', 'link', 'image', 'file']
const hasFilters = computed(() => props.kinds.length > 0 || Boolean(props.sourceApp) || props.pinned !== undefined)
const t = (key: Parameters<typeof translate>[1]) => translate(props.locale, key)

function toggleKind(kind: ClipKind) {
  emit('update:kinds', props.kinds.includes(kind)
    ? props.kinds.filter((candidate) => candidate !== kind)
    : kindOptions.filter((candidate) => candidate === kind || props.kinds.includes(candidate)))
}

function updateSource(event: Event) {
  emit('update:sourceApp', (event.target as HTMLInputElement).value)
}

function updatePinned(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  emit('update:pinned', value === 'pinned' ? true : value === 'unpinned' ? false : undefined)
}

function resetFilters() {
  emit('update:kinds', [])
  emit('update:sourceApp', '')
  emit('update:pinned', undefined)
}
</script>

<template>
  <div class="manager-filters" data-testid="manager-filters">
    <fieldset class="manager-kind-filters">
      <legend>{{ t('managerFilterKind') }}</legend>
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
    </fieldset>

    <label>
      <span>{{ t('managerFilterSource') }}</span>
      <input
        data-testid="manager-source-filter"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :value="sourceApp"
        :placeholder="t('managerFilterSourcePlaceholder')"
        @change="updateSource"
      />
    </label>

    <label>
      <span>{{ t('managerFilterPinned') }}</span>
      <select data-testid="manager-pinned-filter" :value="pinned === true ? 'pinned' : pinned === false ? 'unpinned' : 'any'" @change="updatePinned">
        <option value="any">{{ t('filterAny') }}</option>
        <option value="pinned">{{ t('filterPinned') }}</option>
        <option value="unpinned">{{ t('filterUnpinned') }}</option>
      </select>
    </label>

    <button v-if="hasFilters" data-testid="reset-manager-filters" class="manager-filter-reset" type="button" @click="resetFilters">
      {{ t('resetManagerFilters') }}
    </button>
  </div>
</template>
