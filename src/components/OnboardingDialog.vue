<script setup lang="ts">
import { ref } from 'vue'
import { AlignLeft, Check, Image as ImageIcon, Keyboard, Search, ShieldCheck } from 'lucide-vue-next'
import { formatRelativeTime } from '../domain/clipboard'
import type { Locale, MessageKey } from '../i18n'

type Translator = (key: MessageKey, replacements?: Record<string, string | number>) => string
type OnboardingStep = Readonly<{ eyebrow: string; title: string; description: string }>

const props = defineProps<{
  step: number
  steps: readonly OnboardingStep[]
  currentStep: OnboardingStep
  globalShortcut: string
  sampleBusy: boolean
  nativeRuntime: boolean
  historyReady: boolean
  locale: Locale
  relativeTimeNow: Date
  t: Translator
}>()

const emit = defineEmits<{
  skip: []
  next: []
  addSample: []
  keydown: [event: KeyboardEvent]
}>()

const dialog = ref<HTMLElement | null>(null)
const primary = ref<HTMLButtonElement | null>(null)

function focusStep() {
  const backdrop = document.querySelector<HTMLElement>('.onboarding-backdrop')
  const dialogOverflows = Boolean(dialog.value && dialog.value.scrollHeight > dialog.value.clientHeight + 1)
  dialog.value?.scrollTo({ top: 0, left: 0 })
  backdrop?.scrollTo({ top: 0, left: 0 })
  if (window.innerWidth <= 360 || window.innerHeight <= 360 || dialogOverflows) {
    dialog.value?.focus({ preventScroll: true })
  } else {
    primary.value?.focus({ preventScroll: true })
  }
}

defineExpose({ focusStep })
</script>

<template>
  <div class="onboarding-backdrop">
    <section
      ref="dialog"
      data-testid="onboarding-dialog"
      class="onboarding-dialog"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-description"
      @keydown="emit('keydown', $event)"
    >
      <header class="onboarding-header" data-tauri-drag-region="deep">
        <div class="onboarding-brand">
          <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
          <span>{{ t('productName') }}</span>
        </div>
        <button class="skip-button" type="button" :aria-label="t('skipOnboarding')" @click="emit('skip')">{{ t('skip') }}</button>
      </header>

      <div class="onboarding-visual" :data-step="step">
        <div v-if="step === 0" class="shortcut-visual">
          <span class="floating-sheet sheet-back"></span>
          <span class="floating-sheet sheet-front"><Keyboard :size="27" /></span>
          <div class="shortcut-keys">
            <template v-for="(part, index) in globalShortcut.split('+')" :key="part">
              <span v-if="index">+</span><kbd>{{ part }}</kbd>
            </template>
          </div>
        </div>
        <div v-else-if="step === 1" class="search-visual">
          <div class="mini-search"><Search :size="15" /><span>{{ t('onboardingSearchExample') }}</span><kbd>Enter</kbd></div>
          <div class="mini-result selected"><AlignLeft :size="15" /><span><strong>{{ t('exampleMeetingTitle') }}</strong><small>{{ t('exampleChatApp') }} · {{ formatRelativeTime(relativeTimeNow.toISOString(), relativeTimeNow, locale) }}</small></span><Check :size="15" /></div>
          <div class="mini-result"><ImageIcon :size="15" /><span><strong>{{ t('exampleImageTitle') }}</strong><small>{{ t('exampleCaptureApp') }} · {{ t('twoHoursAgo') }}</small></span></div>
        </div>
        <div v-else class="privacy-visual">
          <span class="privacy-orbit"><ShieldCheck :size="32" /></span>
          <div class="privacy-pill"><span><span class="state-dot"></span>{{ t('localStorage') }}</span><strong>{{ t('enabled') }}</strong></div>
        </div>
      </div>

      <div class="onboarding-copy">
        <span>{{ currentStep.eyebrow }}</span>
        <h1 id="onboarding-title">{{ currentStep.title }}</h1>
        <p id="onboarding-description">{{ currentStep.description }}</p>
      </div>

      <footer class="onboarding-footer">
        <div class="step-dots" role="progressbar" :aria-label="t('guideProgress')" aria-valuemin="1" :aria-valuemax="steps.length" :aria-valuenow="step + 1">
          <span v-for="(_, index) in steps" :key="index" :class="{ active: step === index }"></span>
        </div>
        <button v-if="step < steps.length - 1" ref="primary" data-testid="onboarding-next" class="primary-button onboarding-next" type="button" @click="emit('next')">{{ t('next') }}</button>
        <div v-else class="onboarding-choice-actions">
          <button data-testid="onboarding-skip-sample" class="secondary-button onboarding-next" type="button" :disabled="sampleBusy" @click="emit('skip')">{{ t('onboardingSkipSample') }}</button>
          <button ref="primary" data-testid="onboarding-add-sample" class="primary-button onboarding-next" type="button" :disabled="sampleBusy || (nativeRuntime && !historyReady)" @click="emit('addSample')">{{ sampleBusy ? t('onboardingAddingSample') : t('onboardingAddSample') }}</button>
        </div>
      </footer>
    </section>
  </div>
</template>
