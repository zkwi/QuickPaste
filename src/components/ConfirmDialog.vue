<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'

withDefaults(defineProps<{
  testId: string
  titleId: string
  descriptionId: string
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  cancelTestId: string
  confirmTestId: string
  role?: 'dialog' | 'alertdialog'
  busy?: boolean
  errorMessage?: string
  errorTestId?: string
}>(), {
  role: 'dialog',
  busy: false,
  errorMessage: '',
  errorTestId: undefined,
})

const emit = defineEmits<{
  cancel: []
  confirm: []
  keydown: [event: KeyboardEvent]
}>()
</script>

<template>
  <div class="settings-modal-backdrop" @click.self="emit('cancel')">
    <section
      :data-testid="testId"
      class="settings-modal confirm-modal"
      :role="role"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
      @keydown="emit('keydown', $event)"
    >
      <header>
        <div><Trash2 :size="19" /><span><strong :id="titleId">{{ title }}</strong><small :id="descriptionId">{{ description }}</small></span></div>
      </header>
      <div class="confirm-actions">
        <button :data-testid="cancelTestId" class="secondary-button" type="button" :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button :data-testid="confirmTestId" class="danger-button" type="button" :disabled="busy" @click="emit('confirm')">{{ confirmLabel }}</button>
      </div>
      <p v-if="errorMessage" :data-testid="errorTestId" role="alert">{{ errorMessage }}</p>
    </section>
  </div>
</template>
