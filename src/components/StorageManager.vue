<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Database, FolderOpen, Rows3 } from 'lucide-vue-next'
import { translate, type Locale } from '../i18n'
import type {
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
  statusMessage: string
}>()

const emit = defineEmits<{
  backup: []
  'prepare-restore': []
  'commit-restore': [token: string]
  'discard-restore': [token: string]
  compact: []
  'open-data-directory': []
  refresh: []
}>()

const t = (key: Parameters<typeof translate>[1], replacements?: Record<string, string | number>) => (
  translate(props.locale, key, replacements)
)
const restoreComposing = ref(false)
const lastOperationTrigger = ref<HTMLElement | null>(null)
const prepareRestoreButton = ref<HTMLButtonElement | null>(null)
const restoreConfirmButton = ref<HTMLButtonElement | null>(null)
const isBusy = computed(() => props.busyOperation !== null)
const isReadOnly = computed(() => props.health?.status === 'readOnlyError')
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

function formatStorageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const megabytes = bytes / (1024 * 1024)
  if (megabytes < 0.01) return '< 0.01 MB'
  const maximumFractionDigits = megabytes >= 100 ? 0 : megabytes >= 10 ? 1 : 2
  return new Intl.NumberFormat(props.locale, {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(megabytes) + ' MB'
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

    <aside class="storage-data-location" data-testid="storage-data-location">
      <FolderOpen :size="18" aria-hidden="true" />
      <p>{{ t('storageDataLocationDescription') }}</p>
      <button
        class="storage-directory-button"
        data-testid="storage-open-directory"
        type="button"
        @click="$emit('open-data-directory')"
      >
        {{ t('storageOpenDirectory') }}
      </button>
    </aside>

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

    <section v-if="stats" class="storage-summary" data-testid="storage-summary" :aria-label="t('storageSummary')">
      <article>
        <span class="storage-summary-icon" aria-hidden="true"><Database :size="19" /></span>
        <span>
          <small>{{ t('storageDatabaseSize') }}</small>
          <strong data-testid="storage-database-size">{{ formatStorageSize(stats.totalPhysicalBytes) }}</strong>
        </span>
      </article>
      <article>
        <span class="storage-summary-icon" aria-hidden="true"><Rows3 :size="19" /></span>
        <span>
          <small>{{ t('storageRecordCount') }}</small>
          <strong data-testid="storage-record-count">{{ new Intl.NumberFormat(locale).format(stats.recordCount) }}</strong>
        </span>
      </article>
    </section>

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
          ref="restoreConfirmButton"
          class="storage-danger-button"
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
            ref="prepareRestoreButton"
            class="storage-action-button"
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
