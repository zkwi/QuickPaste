<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { translate, type Locale } from '../i18n'
import type { BatchAction, Collection, ManagerSelectionState } from '../domain/collections'

const props = defineProps<{
  locale: Locale
  selectionState: ManagerSelectionState
  selectedCount: number
  collections: readonly Collection[]
  busy: boolean
  errorMessage: string
  includesPinned: boolean
  includesPermanent: boolean
}>()

const emit = defineEmits<{
  'select-all': []
  'clear-selection': []
  apply: [action: BatchAction]
}>()

const t = (key: Parameters<typeof translate>[1], replacements?: Record<string, string | number>) => (
  translate(props.locale, key, replacements)
)
const moveTarget = ref('')
const deleteConfirmationOpen = ref(false)
const deleteComposing = ref(false)
const deleteButton = ref<HTMLButtonElement | null>(null)
const cancelDeleteButton = ref<HTMLButtonElement | null>(null)
const confirmDeleteButton = ref<HTMLButtonElement | null>(null)

function toggleAll() {
  if (props.busy) return
  if (props.selectionState === 'all') emit('clear-selection')
  else emit('select-all')
}

function applyMove() {
  if (props.busy || props.selectedCount === 0 || !moveTarget.value) return
  if (moveTarget.value === 'unfiled') {
    emit('apply', { type: 'move', collectionId: null })
    return
  }
  if (!moveTarget.value.startsWith('collection:')) return
  const collectionId = moveTarget.value.slice('collection:'.length)
  if (props.collections.some(({ id }) => id === collectionId)) {
    emit('apply', { type: 'move', collectionId })
  }
}

function setPinned(pinned: boolean) {
  if (props.busy || props.selectedCount === 0) return
  emit('apply', { type: 'setPinned', pinned })
}

async function openDeleteConfirmation() {
  if (props.busy || props.selectedCount === 0) return
  deleteConfirmationOpen.value = true
  await nextTick()
  confirmDeleteButton.value?.focus()
}

async function closeDeleteConfirmation() {
  if (props.busy) return
  deleteConfirmationOpen.value = false
  await nextTick()
  deleteButton.value?.focus()
}

function confirmDelete() {
  if (props.busy || deleteComposing.value || !deleteConfirmationOpen.value) return
  emit('apply', { type: 'delete' })
}

function handleConfirmationKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.isComposing || deleteComposing.value) return
  if (props.busy) return
  if (event.key === 'Escape') {
    event.preventDefault()
    void closeDeleteConfirmation()
    return
  }
  if (event.key !== 'Tab') return
  const cancel = cancelDeleteButton.value
  const confirm = confirmDeleteButton.value
  if (!cancel || !confirm) return
  if (event.shiftKey && document.activeElement === cancel) {
    event.preventDefault()
    confirm.focus()
  } else if (!event.shiftKey && document.activeElement === confirm) {
    event.preventDefault()
    cancel.focus()
  }
}
</script>

<template>
  <section
    class="manager-bulk-toolbar"
    data-testid="manager-bulk-toolbar"
    role="toolbar"
    :aria-label="t('managerBulkActions')"
    :aria-busy="busy"
  >
    <div class="manager-bulk-summary">
      <label class="manager-bulk-selection">
        <input
          data-testid="manager-select-all"
          type="checkbox"
          :checked="selectionState === 'all'"
          :indeterminate="selectionState === 'mixed'"
          :aria-label="t('managerSelectAll')"
          :aria-checked="selectionState === 'mixed' ? 'mixed' : selectionState === 'all' ? 'true' : 'false'"
          :disabled="busy"
          @change="toggleAll"
        />
        <span>{{ t('managerSelectAllShort') }}</span>
      </label>
      <p data-testid="manager-selected-count" role="status" aria-live="polite" aria-atomic="true">
        {{ t('managerSelectedCount', { count: selectedCount }) }}
      </p>
    </div>
    <div class="manager-bulk-actions">
      <label class="manager-bulk-move">
        <span>{{ t('managerMoveTo') }}</span>
        <select v-model="moveTarget" data-testid="manager-move-target" :disabled="busy || selectedCount === 0">
          <option value="">{{ t('managerChooseCollection') }}</option>
          <option value="unfiled">{{ t('managerUnfiled') }}</option>
          <option v-for="collection in collections" :key="collection.id" :value="`collection:${collection.id}`">{{ collection.name }}</option>
        </select>
      </label>
      <button data-testid="manager-apply-move" type="button" :disabled="busy || selectedCount === 0 || !moveTarget" @click="applyMove">{{ t('managerApplyMove') }}</button>
      <button data-testid="manager-pin" type="button" :aria-label="t('managerPinSelected')" :disabled="busy || selectedCount === 0" @click="setPinned(true)">{{ t('pinClip') }}</button>
      <button data-testid="manager-unpin" type="button" :aria-label="t('managerUnpinSelected')" :disabled="busy || selectedCount === 0" @click="setPinned(false)">{{ t('unpin') }}</button>
      <button ref="deleteButton" class="manager-bulk-delete" data-testid="manager-delete" type="button" :aria-label="t('managerDeleteSelected')" :disabled="busy || selectedCount === 0" @click="openDeleteConfirmation">{{ t('deleteClip') }}</button>
    </div>

    <div
      v-if="deleteConfirmationOpen"
      class="manager-bulk-confirmation-backdrop"
      data-testid="manager-delete-confirmation"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="manager-delete-title"
      aria-describedby="manager-delete-description"
      @compositionstart="deleteComposing = true"
      @compositionend="deleteComposing = false"
      @keydown="handleConfirmationKeydown"
    >
      <section class="manager-bulk-confirmation">
        <h2 id="manager-delete-title">{{ t('managerDeleteTitle') }}</h2>
        <p id="manager-delete-description">
          {{ t('managerDeleteDescription', { count: selectedCount }) }}
        </p>
        <p v-if="includesPinned && includesPermanent" class="manager-bulk-protected-warning">
          {{ t('managerDeleteProtectedWarning') }}
        </p>
        <p v-else-if="includesPinned" class="manager-bulk-protected-warning">
          {{ t('managerDeletePinnedWarning') }}
        </p>
        <p v-else-if="includesPermanent" class="manager-bulk-protected-warning">
          {{ t('managerDeletePermanentWarning') }}
        </p>
        <div class="manager-bulk-confirmation-actions">
          <button
            ref="cancelDeleteButton"
            data-testid="manager-cancel-delete"
            type="button"
            :disabled="busy"
            @click="closeDeleteConfirmation"
          >
            {{ t('cancel') }}
          </button>
          <button
            ref="confirmDeleteButton"
            data-testid="manager-confirm-delete"
            type="button"
            :disabled="busy || deleteComposing"
            @click="confirmDelete"
          >
            {{ t('managerConfirmDelete') }}
          </button>
        </div>
      </section>
    </div>
    <p
      v-if="errorMessage"
      class="manager-bulk-error"
      data-testid="manager-bulk-error"
      role="alert"
      aria-live="assertive"
    >
      {{ errorMessage }}
    </p>
  </section>
</template>
