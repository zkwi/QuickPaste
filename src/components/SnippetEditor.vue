<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { translate, type Locale } from '../i18n'
import { normalizeSnippetDraft, type Collection, type SnippetDraft } from '../domain/collections'
import { trimSearchWhitespace } from '../domain/clipboard'

const props = defineProps<{
  locale: Locale
  modelValue: SnippetDraft
  collections: readonly Collection[]
  busy: boolean
  errorMessage: string
}>()

const emit = defineEmits<{
  'update:modelValue': [draft: SnippetDraft]
  save: [draft: SnippetDraft]
  cancel: [draft: SnippetDraft]
}>()

const draft = reactive<SnippetDraft>({
  ...(props.modelValue.id === undefined ? {} : { id: props.modelValue.id }),
  title: props.modelValue.title,
  content: props.modelValue.content,
  ...(props.modelValue.collectionId === undefined
    ? {}
    : { collectionId: props.modelValue.collectionId }),
  kind: props.modelValue.kind,
})
const collectionValue = computed({
  get: () => draft.collectionId === undefined ? 'unfiled' : `collection:${draft.collectionId}`,
  set: (value: string) => {
    if (value === 'unfiled') delete draft.collectionId
    else if (value.startsWith('collection:')) draft.collectionId = value.slice('collection:'.length)
  },
})
const collectionMissing = computed(() => draft.collectionId !== undefined
  && !props.collections.some(({ id }) => id === draft.collectionId))
const t = (key: Parameters<typeof translate>[1]) => translate(props.locale, key)
const validationError = ref('')
const isComposing = ref(false)
const titleInput = ref<HTMLInputElement | null>(null)
const saveButton = ref<HTMLButtonElement | null>(null)
const focusReturnTarget = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
  ? document.activeElement
  : null
let syncingExternalIdentity = false

function snapshotDraft(): SnippetDraft {
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    title: draft.title,
    content: draft.content,
    ...(draft.collectionId === undefined ? {} : { collectionId: draft.collectionId }),
    kind: draft.kind,
  }
}

watch(draft, () => {
  if (syncingExternalIdentity) return
  validationError.value = ''
  emit('update:modelValue', snapshotDraft())
}, { flush: 'sync' })

watch(
  () => props.modelValue.id,
  (nextId, previousId) => {
    if (nextId === previousId) return
    syncingExternalIdentity = true
    if (nextId === undefined) delete draft.id
    else draft.id = nextId
    draft.title = props.modelValue.title
    draft.content = props.modelValue.content
    draft.kind = props.modelValue.kind
    if (props.modelValue.collectionId === undefined) delete draft.collectionId
    else draft.collectionId = props.modelValue.collectionId
    validationError.value = ''
    syncingExternalIdentity = false
  },
  { flush: 'sync' },
)

function saveDraft() {
  if (props.busy) return
  if (!trimSearchWhitespace(draft.title)) {
    validationError.value = t('snippetTitleRequired')
    return
  }
  if (!trimSearchWhitespace(draft.content)) {
    validationError.value = t('snippetContentRequired')
    return
  }
  if (draft.kind !== 'text' && draft.kind !== 'code') {
    validationError.value = t('snippetKindInvalid')
    return
  }
  if (draft.collectionId !== undefined
    && !props.collections.some(({ id }) => id === draft.collectionId)) {
    validationError.value = t('snippetCollectionMissing')
    return
  }
  try {
    const normalized = normalizeSnippetDraft(snapshotDraft(), props.collections)
    validationError.value = ''
    emit('save', normalized)
  } catch {
    validationError.value = t('snippetDraftInvalid')
  }
}

function cancelDraft() {
  if (props.busy) return
  emit('cancel', snapshotDraft())
}

function handleEditorKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.isComposing || isComposing.value || props.busy) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelDraft()
    return
  }
  if (event.key === 'Enter') {
    const target = event.target
    const isTitle = target === titleInput.value
    const isControlEnter = target instanceof HTMLTextAreaElement && (event.ctrlKey || event.metaKey)
    if (isTitle || isControlEnter) {
      event.preventDefault()
      saveDraft()
    }
    return
  }
  if (event.key !== 'Tab') return
  const first = titleInput.value
  const last = saveButton.value
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  await nextTick()
  titleInput.value?.focus()
})

onBeforeUnmount(() => {
  if (focusReturnTarget?.isConnected) focusReturnTarget.focus()
})
</script>

<template>
  <section
    class="snippet-editor-backdrop"
    data-testid="snippet-editor"
    role="dialog"
    aria-modal="true"
    aria-labelledby="snippet-editor-heading"
    :aria-busy="busy"
    @compositionstart="isComposing = true"
    @compositionend="isComposing = false"
    @keydown="handleEditorKeydown"
  >
    <form class="snippet-editor" @submit.prevent="saveDraft">
      <header>
        <h2 id="snippet-editor-heading" data-testid="snippet-editor-title">
          {{ t(draft.id === undefined ? 'snippetCreateTitle' : 'snippetEditTitle') }}
        </h2>
      </header>

      <label>
        <span>{{ t('snippetTitleLabel') }}</span>
        <input ref="titleInput" v-model="draft.title" data-testid="snippet-title" type="text" :disabled="busy" />
      </label>
      <label>
        <span>{{ t('snippetContentLabel') }}</span>
        <textarea v-model="draft.content" data-testid="snippet-content" :disabled="busy" />
      </label>
      <div class="snippet-editor-selects">
        <label>
          <span>{{ t('snippetKindLabel') }}</span>
          <select v-model="draft.kind" data-testid="snippet-kind" :disabled="busy">
            <option value="text">{{ t('text') }}</option>
            <option value="code">{{ t('code') }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('snippetCollectionLabel') }}</span>
          <select v-model="collectionValue" data-testid="snippet-collection" :disabled="busy">
            <option value="unfiled">{{ t('managerUnfiled') }}</option>
            <option
              v-if="collectionMissing && draft.collectionId !== undefined"
              :value="`collection:${draft.collectionId}`"
              disabled
            >
              {{ t('snippetMissingCollectionOption') }}
            </option>
            <option v-for="collection in collections" :key="collection.id" :value="`collection:${collection.id}`">
              {{ collection.name }}
            </option>
          </select>
        </label>
      </div>

      <footer>
        <button data-testid="snippet-cancel" type="button" :disabled="busy" @click="cancelDraft">
          {{ t('cancel') }}
        </button>
        <button ref="saveButton" data-testid="snippet-save" type="submit" :disabled="busy">
          {{ busy ? t('snippetSaving') : t('snippetSave') }}
        </button>
      </footer>
      <p
        v-if="validationError"
        data-testid="snippet-validation-error"
        role="alert"
        aria-live="assertive"
      >
        {{ validationError }}
      </p>
      <p
        v-if="errorMessage"
        data-testid="snippet-error"
        role="alert"
        aria-live="assertive"
      >
        {{ errorMessage }}
      </p>
    </form>
  </section>
</template>
