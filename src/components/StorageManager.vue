<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { translate, type Locale } from '../i18n'
import type {
  CapacityPolicy,
  HistoryHealth,
  PreparedRestore,
  StorageOperation,
  StorageStats,
} from '../platform/history'

const props = defineProps<{
  locale: Locale
  stats: StorageStats | null
  health: HistoryHealth | null
  preparedRestore: PreparedRestore | null
  busyOperation: StorageOperation
  policyEditable: boolean
  statusMessage: string
}>()

const emit = defineEmits<{
  backup: []
  'prepare-restore': []
  'commit-restore': [token: string]
  'discard-restore': [token: string]
  'update-policy': [policy: Pick<CapacityPolicy, 'maxRecords' | 'maxImageBytes'>]
  compact: []
  refresh: []
}>()

const t = (key: Parameters<typeof translate>[1], replacements?: Record<string, string | number>) => (
  translate(props.locale, key, replacements)
)
const restoreComposing = ref(false)
const lastOperationTrigger = ref<HTMLElement | null>(null)
const prepareRestoreButton = ref<HTMLButtonElement | null>(null)
const restoreConfirmButton = ref<HTMLButtonElement | null>(null)
const policyApplyButton = ref<HTMLButtonElement | null>(null)
const policyCancelButton = ref<HTMLButtonElement | null>(null)
const policyConfirmButton = ref<HTMLButtonElement | null>(null)
const policyComposing = ref(false)
const maxRecordsDraft = ref('')
const maxImageBytesDraft = ref('')
const policyError = ref('')
const pendingPolicy = ref<Pick<CapacityPolicy, 'maxRecords' | 'maxImageBytes'> | null>(null)
const isBusy = computed(() => props.busyOperation !== null)
const isReadOnly = computed(() => props.health?.status === 'readOnlyError')
const policyControlsDisabled = computed(() => (
  !props.policyEditable || isBusy.value || isReadOnly.value || props.stats === null
))
const busyMessage = computed(() => {
  switch (props.busyOperation) {
    case 'backup': return t('storageBackupBusy')
    case 'prepare-restore': return t('storagePrepareRestoreBusy')
    case 'commit-restore': return t('storageCommitRestoreBusy')
    case 'discard-restore': return t('storageDiscardRestoreBusy')
    case 'compact': return t('storageCompactBusy')
    case 'refresh': return t('storageRefreshBusy')
    case 'policy': return t('storagePolicyBusy')
    case null: return ''
  }
})
const healthReason = computed(() => {
  const current = props.health
  if (!current || current.status === 'healthy') return ''
  switch (current.reason) {
    case 'corrupt': return t('storageReasonCorrupt')
    case 'notADatabase': return t('storageReasonNotADatabase')
    case 'busy': return t('storageReasonBusy')
    case 'permissionDenied': return t('storageReasonPermissionDenied')
    case 'io': return t('storageReasonIo')
    case 'diskFull': return t('storageReasonDiskFull')
    case 'incompatible': return t('storageReasonIncompatible')
    case 'quarantineFailed': return t('storageReasonQuarantineFailed')
    case 'freshDatabaseFailed': return t('storageReasonFreshDatabaseFailed')
    case 'unknown': return t('storageReasonUnknown')
  }
})
const recoveryReason = computed(() => {
  const current = props.health
  if (!current || current.status !== 'readOnlyError' || current.reason !== 'freshDatabaseFailed') return ''
  return current.recoveryReason === 'corrupt'
    ? t('storageReasonCorrupt')
    : t('storageReasonNotADatabase')
})

watch(
  () => props.busyOperation,
  (operation, previousOperation) => {
    if (previousOperation !== null && operation === null && lastOperationTrigger.value?.isConnected) {
      lastOperationTrigger.value.focus()
    }
  },
  { flush: 'post' },
)

watch(
  () => props.preparedRestore,
  (prepared, previousPrepared) => {
    if (prepared && !previousPrepared) restoreConfirmButton.value?.focus()
  },
  { flush: 'post' },
)

watch(
  () => [props.stats?.maxRecords, props.stats?.maxImageBytes] as const,
  ([maxRecords, maxImageBytes]) => {
    maxRecordsDraft.value = maxRecords === undefined ? '' : String(maxRecords)
    maxImageBytesDraft.value = maxImageBytes === undefined ? '' : String(maxImageBytes)
    policyError.value = ''
    pendingPolicy.value = null
  },
  { immediate: true },
)

function formatExactBytes(bytes: number): string {
  return `${new Intl.NumberFormat(props.locale).format(bytes)} B`
}

function formatTimestamp(value: string | null): string {
  if (!value) return t('storageNoTimestamp')
  return new Intl.DateTimeFormat(props.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function commitPreparedRestore() {
  if (restoreComposing.value || !props.preparedRestore) return
  emit('commit-restore', props.preparedRestore.token)
}

function discardPreparedRestore() {
  if (!props.preparedRestore) return
  prepareRestoreButton.value?.focus()
  emit('discard-restore', props.preparedRestore.token)
}

function rememberOperationTrigger(event: Event) {
  lastOperationTrigger.value = event.currentTarget as HTMLElement
}

function requestBackup(event: Event) {
  if (isBusy.value || isReadOnly.value) return
  rememberOperationTrigger(event)
  emit('backup')
}

function requestRestore(event: Event) {
  if (isBusy.value || isReadOnly.value) return
  rememberOperationTrigger(event)
  emit('prepare-restore')
}

function requestCompact(event: Event) {
  if (isBusy.value || isReadOnly.value) return
  rememberOperationTrigger(event)
  emit('compact')
}

function requestRefresh(event: Event) {
  if (isBusy.value) return
  rememberOperationTrigger(event)
  emit('refresh')
}

function parseSafeUnsignedInteger(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

async function requestPolicyUpdate() {
  if (policyControlsDisabled.value || !props.stats) return
  const maxRecords = parseSafeUnsignedInteger(maxRecordsDraft.value)
  const maxImageBytes = parseSafeUnsignedInteger(maxImageBytesDraft.value)
  if (maxRecords === null || maxImageBytes === null) {
    policyError.value = t('storagePolicyInvalid')
    return
  }
  policyError.value = ''
  if (maxRecords === props.stats.maxRecords && maxImageBytes === props.stats.maxImageBytes) return

  const policy = { maxRecords, maxImageBytes }
  const mayPrune = maxRecords < props.stats.maxRecords && props.stats.recordCount > maxRecords
    || maxImageBytes < props.stats.maxImageBytes && props.stats.imageBytes > maxImageBytes
  if (!mayPrune) {
    emit('update-policy', policy)
    return
  }
  pendingPolicy.value = policy
  await nextTick()
  policyConfirmButton.value?.focus()
}

function cancelPolicyUpdate() {
  pendingPolicy.value = null
  nextTick(() => policyApplyButton.value?.focus())
}

function confirmPolicyUpdate() {
  if (policyControlsDisabled.value || !pendingPolicy.value) return
  const policy = pendingPolicy.value
  pendingPolicy.value = null
  emit('update-policy', policy)
}

function handlePolicyConfirmationKeydown(event: KeyboardEvent) {
  if (event.isComposing || policyComposing.value) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
    }
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancelPolicyUpdate()
    return
  }
  if (event.key !== 'Tab') return
  const buttons = [policyCancelButton.value, policyConfirmButton.value]
    .filter((button): button is HTMLButtonElement => button !== null && !button.disabled)
  if (buttons.length === 0) return
  event.preventDefault()
  const currentIndex = buttons.findIndex((button) => button === document.activeElement)
  const direction = event.shiftKey ? -1 : 1
  buttons[(currentIndex + direction + buttons.length) % buttons.length]?.focus()
}
</script>

<template>
  <section
    class="storage-manager"
    aria-labelledby="storage-manager-title"
    :aria-busy="isBusy"
    data-testid="storage-manager"
  >
    <header class="storage-manager-header">
      <div>
        <h2 id="storage-manager-title">{{ t('storageTitle') }}</h2>
        <p>{{ t('storageDescription') }}</p>
      </div>
    </header>

    <aside
      v-if="health?.status === 'recovered'"
      class="storage-health-notice storage-health-recovered"
      data-testid="storage-recovery-notice"
      role="alert"
    >
      <div>
        <h3>{{ t('storageRecoveredTitle') }}</h3>
        <p>{{ t('storageRecoveredDescription') }}</p>
      </div>
      <dl>
        <div>
          <dt>{{ t('storageHealthReason') }}</dt>
          <dd>{{ healthReason }}</dd>
        </div>
        <div>
          <dt>{{ t('storageQuarantinePath') }}</dt>
          <dd><code>{{ health.quarantinePath }}</code></dd>
        </div>
      </dl>
    </aside>

    <aside
      v-else-if="health?.status === 'readOnlyError'"
      class="storage-health-notice storage-health-error"
      data-testid="storage-health-error"
      role="alert"
    >
      <div>
        <h3>{{ t('storageReadOnlyTitle') }}</h3>
        <p>{{ t('storageReadOnlyDescription') }}</p>
      </div>
      <p><strong>{{ t('storageHealthReason') }}:</strong> {{ healthReason }}</p>
      <dl v-if="health.reason === 'freshDatabaseFailed'">
        <div>
          <dt>{{ t('storageHealthReason') }}</dt>
          <dd>{{ recoveryReason }}</dd>
        </div>
        <div>
          <dt>{{ t('storageQuarantinePath') }}</dt>
          <dd><code>{{ health.quarantinePath }}</code></dd>
        </div>
      </dl>
    </aside>

    <template v-if="stats">
      <section class="storage-panel storage-physical" data-testid="storage-physical">
        <header>
          <h3>{{ t('storagePhysicalTitle') }}</h3>
          <p>{{ t('storagePhysicalDescription') }}</p>
        </header>
        <dl class="storage-metrics storage-physical-grid">
          <div data-testid="storage-database-bytes">
            <dt>{{ t('storageDatabase') }}</dt>
            <dd>{{ formatExactBytes(stats.databaseBytes) }}</dd>
          </div>
          <div data-testid="storage-wal-bytes">
            <dt>{{ t('storageWal') }}</dt>
            <dd>{{ formatExactBytes(stats.walBytes) }}</dd>
          </div>
          <div data-testid="storage-shm-bytes">
            <dt>{{ t('storageShm') }}</dt>
            <dd>{{ formatExactBytes(stats.shmBytes) }}</dd>
          </div>
          <div class="storage-total" data-testid="storage-total-physical-bytes">
            <dt>{{ t('storagePhysicalTotal') }}</dt>
            <dd>{{ formatExactBytes(stats.totalPhysicalBytes) }}</dd>
          </div>
        </dl>
      </section>

      <section class="storage-panel storage-logical" data-testid="storage-logical">
        <header>
          <h3>{{ t('storageLogicalTitle') }}</h3>
          <p>{{ t('storageLogicalDescription') }}</p>
        </header>
        <p class="storage-record-summary">
          {{ t('storageRecordSummary', {
            count: stats.recordCount,
            pinned: stats.pinnedCount,
            permanent: stats.permanentCount,
          }) }}
        </p>
        <dl class="storage-metrics">
          <div>
            <dt>{{ t('storageImagePayload') }}</dt>
            <dd>{{ formatExactBytes(stats.imageBytes) }}</dd>
          </div>
          <div>
            <dt>{{ t('storageRichPayload') }}</dt>
            <dd>{{ formatExactBytes(stats.richFormatBytes) }}</dd>
          </div>
          <div>
            <dt>{{ t('storageFileRecords') }}</dt>
            <dd>{{ new Intl.NumberFormat(locale).format(stats.fileRecordCount) }}</dd>
          </div>
          <div>
            <dt>{{ t('storageLogicalTotal') }}</dt>
            <dd>{{ formatExactBytes(stats.logicalBytes) }}</dd>
          </div>
        </dl>
      </section>

      <section class="storage-panel storage-policy" data-testid="storage-policy">
        <header>
          <h3>{{ t('storagePolicyTitle') }}</h3>
          <p>{{ t('storagePolicyDescription') }}</p>
        </header>
        <ul class="storage-policy-list">
          <li>{{ t('storageMaxRecords', { count: new Intl.NumberFormat(locale).format(stats.maxRecords) }) }}</li>
          <li>{{ t('storageMaxImageBytes', { bytes: formatExactBytes(stats.maxImageBytes) }) }}</li>
          <li>{{ stats.retentionDays === null
            ? t('storageRetentionForever')
            : t('storageRetentionDays', { count: stats.retentionDays }) }}</li>
        </ul>
        <form class="storage-policy-editor" data-testid="storage-policy-editor" @submit.prevent="requestPolicyUpdate">
          <label>
            <span>{{ t('storagePolicyRecordsLabel') }}</span>
            <span class="storage-policy-input">
              <input
                v-model="maxRecordsDraft"
                data-testid="storage-max-records"
                type="number"
                min="0"
                :max="Number.MAX_SAFE_INTEGER"
                step="1"
                inputmode="numeric"
                :disabled="policyControlsDisabled"
                :aria-describedby="policyError ? 'storage-policy-error' : 'storage-policy-range'"
                @input="policyError = ''"
              />
              <span>{{ t('storagePolicyRecordsUnit') }}</span>
            </span>
          </label>
          <label>
            <span>{{ t('storagePolicyImageBytesLabel') }}</span>
            <span class="storage-policy-input">
              <input
                v-model="maxImageBytesDraft"
                data-testid="storage-max-image-bytes"
                type="number"
                min="0"
                :max="Number.MAX_SAFE_INTEGER"
                step="1"
                inputmode="numeric"
                :disabled="policyControlsDisabled"
                :aria-describedby="policyError ? 'storage-policy-error' : 'storage-policy-range'"
                @input="policyError = ''"
              />
              <span>{{ t('storagePolicyBytesUnit') }}</span>
            </span>
          </label>
          <button
            ref="policyApplyButton"
            data-testid="storage-apply-policy"
            type="button"
            :disabled="policyControlsDisabled"
            @click="requestPolicyUpdate"
          >{{ busyOperation === 'policy' ? t('storagePolicyBusy') : t('storagePolicyApply') }}</button>
          <small id="storage-policy-range">{{ t('storagePolicyRange', { max: new Intl.NumberFormat(locale).format(Number.MAX_SAFE_INTEGER) }) }}</small>
          <p v-if="policyError" id="storage-policy-error" data-testid="storage-policy-error" role="alert">{{ policyError }}</p>
        </form>
        <div class="storage-timeline">
          <strong>{{ t('storageTimeline') }}</strong>
          <dl>
            <div>
              <dt>{{ t('storageOldest') }}</dt>
              <dd>{{ formatTimestamp(stats.oldestCopiedAt) }}</dd>
            </div>
            <div>
              <dt>{{ t('storageNewest') }}</dt>
              <dd>{{ formatTimestamp(stats.newestCopiedAt) }}</dd>
            </div>
          </dl>
        </div>
      </section>
    </template>

    <div v-if="pendingPolicy" class="storage-policy-confirmation-backdrop">
      <section
        class="storage-policy-confirmation"
        data-testid="storage-policy-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="storage-policy-confirmation-title"
        aria-describedby="storage-policy-confirmation-description"
        @compositionstart="policyComposing = true"
        @compositionend="policyComposing = false"
        @keydown="handlePolicyConfirmationKeydown"
      >
        <h3 id="storage-policy-confirmation-title">{{ t('storagePolicyConfirmationTitle') }}</h3>
        <p id="storage-policy-confirmation-description">{{ t('storagePolicyConfirmationDescription') }}</p>
        <div>
          <button ref="policyCancelButton" data-testid="storage-cancel-policy" type="button" @click="cancelPolicyUpdate">{{ t('cancel') }}</button>
          <button ref="policyConfirmButton" data-testid="storage-confirm-policy" type="button" @click="confirmPolicyUpdate">{{ t('storagePolicyConfirm') }}</button>
        </div>
      </section>
    </div>

    <section
      v-if="preparedRestore"
      class="storage-restore-confirmation"
      data-testid="storage-restore-confirmation"
      role="alertdialog"
      aria-labelledby="storage-restore-title"
      aria-describedby="storage-restore-description"
      @compositionstart="restoreComposing = true"
      @compositionend="restoreComposing = false"
    >
      <div>
        <h3 id="storage-restore-title">{{ t('storageRestorePreparedTitle') }}</h3>
        <p class="storage-restore-counts">
          {{ t('storageRestoreCounts', {
            incoming: preparedRestore.incomingCount,
            current: preparedRestore.currentCount,
            schema: preparedRestore.schemaVersion,
          }) }}
        </p>
        <p id="storage-restore-description" class="storage-restore-danger">
          {{ t('storageRestoreDestructive') }}
        </p>
      </div>
      <div class="storage-restore-actions">
        <button
          class="storage-cancel-button"
          data-testid="storage-discard-restore"
          type="button"
          :disabled="isBusy"
          @click="discardPreparedRestore"
        >
          {{ busyOperation === 'discard-restore' ? t('storageDiscardRestoreBusy') : t('cancel') }}
        </button>
        <button
          class="storage-danger-button"
          ref="restoreConfirmButton"
          data-testid="storage-commit-restore"
          type="button"
          :disabled="isBusy || isReadOnly || restoreComposing"
          @click="commitPreparedRestore"
        >
          {{ busyOperation === 'commit-restore' ? t('storageCommitRestoreBusy') : t('storageRestoreConfirm') }}
        </button>
      </div>
    </section>

    <section class="storage-panel storage-operations" data-testid="storage-operations">
      <header>
        <h3>{{ t('storageSafetyTitle') }}</h3>
      </header>

      <div class="storage-operation-grid">
        <article class="storage-operation-card">
          <div>
            <h4>{{ t('storageBackup') }}</h4>
            <p>{{ t('storageBackupDescription') }}</p>
          </div>
          <button
            class="storage-action-button"
            data-testid="storage-backup"
            type="button"
            :disabled="isBusy || isReadOnly"
            @click="requestBackup"
          >
            {{ busyOperation === 'backup' ? t('storageBackupBusy') : t('storageBackup') }}
          </button>
        </article>

        <article class="storage-operation-card">
          <div>
            <h4>{{ t('storageRestore') }}</h4>
            <p>{{ t('storageRestoreDescription') }}</p>
          </div>
          <button
            class="storage-action-button"
            ref="prepareRestoreButton"
            data-testid="storage-prepare-restore"
            type="button"
            :disabled="isBusy || isReadOnly"
            @click="requestRestore"
          >
            {{ busyOperation === 'prepare-restore' ? t('storagePrepareRestoreBusy') : t('storageRestore') }}
          </button>
        </article>

        <article class="storage-operation-card">
          <div>
            <h4>{{ t('storageCompact') }}</h4>
            <p>{{ t('storageCompactDescription') }}</p>
            <small data-testid="storage-compact-note">{{ t('storageCompactNote') }}</small>
          </div>
          <button
            class="storage-action-button"
            data-testid="storage-compact"
            type="button"
            :disabled="isBusy || isReadOnly"
            @click="requestCompact"
          >
            {{ busyOperation === 'compact' ? t('storageCompactBusy') : t('storageCompact') }}
          </button>
        </article>
      </div>

      <footer class="storage-operations-footer">
        <button
          class="storage-refresh-button"
          data-testid="storage-refresh"
          type="button"
          :disabled="isBusy"
          @click="requestRefresh"
        >
          {{ busyOperation === 'refresh' ? t('storageRefreshBusy') : t('storageRefresh') }}
        </button>
      </footer>
    </section>

    <p
      class="storage-status"
      data-testid="storage-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ busyMessage || statusMessage }}
    </p>
  </section>
</template>
