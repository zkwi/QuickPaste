import { computed, nextTick, ref, type Ref } from 'vue'
import { createClipboardItem, type ClipboardItem, type LoadedClipboardItem } from '../domain/clipboard'
import { displayShortcut } from '../domain/shortcut'
import type { MessageKey } from '../i18n'
import { setOnboardingWindowActive } from '../platform/window'

type Translator = (key: MessageKey, replacements?: Record<string, string | number>) => string

export interface OnboardingDialogHandle {
  focusStep: () => void
}

interface UseOnboardingOptions {
  completed: boolean
  practicePending: boolean
  nativeRuntime: boolean
  globalShortcut: Ref<string>
  items: Ref<ClipboardItem[]>
  selectedId: Ref<string>
  searchInput: Ref<HTMLInputElement | null>
  t: Translator
  persistNativeSample: (sample: LoadedClipboardItem) => Promise<boolean>
  showToast: (message: string, urgent?: boolean) => void
}

export const ONBOARDING_SAMPLE_ID = 'quickpaste-onboarding-sample-v1'

export function useOnboarding(options: UseOnboardingOptions) {
  const onboardingCompleted = ref(options.completed)
  const onboardingPracticePending = ref(options.practicePending)
  const onboardingStep = ref(options.completed ? -1 : 0)
  const onboardingSampleBusy = ref(false)
  const onboardingDialog = ref<OnboardingDialogHandle | null>(null)

  const onboardingSteps = computed(() => [
    {
      eyebrow: options.t('onboardingQuickEyebrow'),
      title: options.t('onboardingQuickTitle'),
      description: options.t('onboardingQuickDescription', { shortcut: displayShortcut(options.globalShortcut.value) }),
    },
    {
      eyebrow: options.t('onboardingEfficientEyebrow'),
      title: options.t('onboardingEfficientTitle'),
      description: options.t('onboardingEfficientDescription'),
    },
    {
      eyebrow: options.t('onboardingPrivateEyebrow'),
      title: options.t('onboardingPrivateTitle'),
      description: options.t('onboardingPrivateDescription'),
    },
  ] as const)

  const currentOnboardingStep = computed(() => (
    onboardingSteps.value[onboardingStep.value] ?? onboardingSteps.value[0]
  ))
  const onboardingPracticeVisible = computed(() => (
    onboardingStep.value < 0 && onboardingPracticePending.value
  ))

  function finishOnboarding() {
    onboardingPracticePending.value = false
    onboardingCompleted.value = true
    onboardingStep.value = -1
    if (options.nativeRuntime) void setOnboardingWindowActive(false)
    nextTick(() => options.searchInput.value?.focus())
  }

  function createOnboardingSample(): LoadedClipboardItem {
    return createClipboardItem({
      kind: 'text',
      content: options.t('onboardingSampleContent'),
      capturedAt: new Date().toISOString(),
      sourceApp: 'QuickPaste',
      formats: ['text'],
    }, ONBOARDING_SAMPLE_ID)
  }

  async function addOnboardingSample(): Promise<boolean> {
    const existing = options.items.value.find((clip) => clip.id === ONBOARDING_SAMPLE_ID)
    if (existing) {
      options.selectedId.value = existing.id
      return true
    }

    const sample = createOnboardingSample()
    if (!options.nativeRuntime) {
      options.items.value = [sample, ...options.items.value]
      options.selectedId.value = sample.id
      return true
    }

    if (!await options.persistNativeSample(sample)) return false
    options.selectedId.value = ONBOARDING_SAMPLE_ID
    return true
  }

  async function finishOnboardingWithSample() {
    if (onboardingSampleBusy.value) return
    onboardingSampleBusy.value = true
    try {
      if (!await addOnboardingSample()) {
        options.showToast(options.t('onboardingSampleFailed'), true)
        return
      }
      onboardingPracticePending.value = true
      onboardingCompleted.value = true
      onboardingStep.value = -1
      if (options.nativeRuntime) void setOnboardingWindowActive(false)
      nextTick(() => options.searchInput.value?.focus())
    } finally {
      onboardingSampleBusy.value = false
    }
  }

  function dismissOnboardingPractice() {
    onboardingPracticePending.value = false
    nextTick(() => options.searchInput.value?.focus())
  }

  function focusOnboardingStep() {
    onboardingDialog.value?.focusStep()
  }

  function advanceOnboarding() {
    if (onboardingStep.value < onboardingSteps.value.length - 1) onboardingStep.value += 1
    else finishOnboarding()
    nextTick(focusOnboardingStep)
  }

  return {
    onboardingCompleted,
    onboardingPracticePending,
    onboardingStep,
    onboardingSampleBusy,
    onboardingDialog,
    onboardingSteps,
    currentOnboardingStep,
    onboardingPracticeVisible,
    finishOnboarding,
    finishOnboardingWithSample,
    dismissOnboardingPractice,
    focusOnboardingStep,
    advanceOnboarding,
  }
}
