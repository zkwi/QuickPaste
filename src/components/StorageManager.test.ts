import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import StorageManager from './StorageManager.vue'

const styles = readFileSync('src/style.css', 'utf8')

const stats = {
  databaseBytes: 4096,
  walBytes: 1024,
  shmBytes: 512,
  totalPhysicalBytes: 5632,
  recordCount: 8,
  pinnedCount: 2,
  permanentCount: 1,
  imageBytes: 2048,
  richFormatBytes: 768,
  fileRecordCount: 3,
  logicalBytes: 12_288,
  oldestCopiedAt: '2026-06-01T08:00:00.000Z',
  newestCopiedAt: '2026-07-19T12:30:00.000Z',
  maxRecords: 500,
  maxImageBytes: 268_435_456,
  retentionDays: 30,
}

const baseProps = {
  locale: 'en-US' as const,
  stats,
  health: { status: 'healthy' as const },
  preparedRestore: null,
  busyOperation: null,
  policyEditable: true,
  statusMessage: '',
}

describe('StorageManager', () => {
  it('separates exact on-disk files from logical content and active policy', () => {
    const wrapper = mount(StorageManager, { props: baseProps })

    expect(wrapper.get('[data-testid="storage-physical"]').text()).toContain('On-disk files')
    expect(wrapper.get('[data-testid="storage-database-bytes"]').text()).toContain('4,096 B')
    expect(wrapper.get('[data-testid="storage-wal-bytes"]').text()).toContain('1,024 B')
    expect(wrapper.get('[data-testid="storage-shm-bytes"]').text()).toContain('512 B')
    expect(wrapper.get('[data-testid="storage-total-physical-bytes"]').text()).toContain('5,632 B')

    const logical = wrapper.get('[data-testid="storage-logical"]').text()
    expect(logical).toContain('Logical clipboard data')
    expect(logical).toContain('8')
    expect(logical).toContain('2 pinned')
    expect(logical).toContain('1 permanent')
    expect(logical).toContain('2,048 B')
    expect(logical).toContain('768 B')
    expect(logical).toContain('3')

    const policy = wrapper.get('[data-testid="storage-policy"]').text()
    expect(policy).toContain('Active limits')
    expect(policy).toContain('500 records')
    expect(policy).toContain('268,435,456 B')
    expect(policy).toContain('30 days')
    expect(wrapper.text()).toContain('Jun 1, 2026')
    expect(wrapper.text()).toContain('Jul 19, 2026')
  })

  it('accepts only explicit safe integers with visible record and byte units', async () => {
    const wrapper = mount(StorageManager, { props: baseProps })
    const records = wrapper.get<HTMLInputElement>('[data-testid="storage-max-records"]')
    const imageBytes = wrapper.get<HTMLInputElement>('[data-testid="storage-max-image-bytes"]')

    expect(records.element.value).toBe('500')
    expect(records.attributes()).toMatchObject({ min: '0', max: String(Number.MAX_SAFE_INTEGER), step: '1' })
    expect(imageBytes.element.value).toBe('268435456')
    expect(imageBytes.attributes()).toMatchObject({ min: '0', max: String(Number.MAX_SAFE_INTEGER), step: '1' })
    expect(wrapper.get('[data-testid="storage-policy-editor"]').text()).toContain('records')
    expect(wrapper.get('[data-testid="storage-policy-editor"]').text()).toContain('B')

    await records.setValue('9007199254740992')
    await imageBytes.setValue('1.5')
    await wrapper.get('[data-testid="storage-apply-policy"]').trigger('click')

    expect(wrapper.get('[data-testid="storage-policy-error"]').text()).toContain('whole number')
    expect(wrapper.emitted('update-policy')).toBeUndefined()

    await records.setValue('750')
    await imageBytes.setValue('134217728')
    await wrapper.get('[data-testid="storage-apply-policy"]').trigger('click')

    expect(wrapper.emitted('update-policy')?.at(-1)).toEqual([{ maxRecords: 750, maxImageBytes: 134_217_728 }])
  })

  it('requires confirmation before a lower policy may immediately prune history', async () => {
    const wrapper = mount(StorageManager, {
      attachTo: document.body,
      props: {
        ...baseProps,
        stats: { ...stats, recordCount: 800, maxRecords: 1_000 },
      },
    })

    await wrapper.get('[data-testid="storage-max-records"]').setValue('100')
    await wrapper.get('[data-testid="storage-apply-policy"]').trigger('click')

    const confirmation = wrapper.get('[data-testid="storage-policy-confirmation"]')
    expect(confirmation.attributes('role')).toBe('alertdialog')
    expect(confirmation.text()).toContain('permanently remove')
    expect(wrapper.emitted('update-policy')).toBeUndefined()
    const confirm = wrapper.get<HTMLButtonElement>('[data-testid="storage-confirm-policy"]')
    expect(document.activeElement).toBe(confirm.element)

    const composingEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      isComposing: true,
    })
    confirm.element.dispatchEvent(composingEnter)
    expect(composingEnter.defaultPrevented).toBe(true)
    expect(wrapper.emitted('update-policy')).toBeUndefined()

    await confirm.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(wrapper.get('[data-testid="storage-cancel-policy"]').element)

    await wrapper.get('[data-testid="storage-cancel-policy"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="storage-policy-confirmation"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="storage-apply-policy"]').element)

    await wrapper.get('[data-testid="storage-apply-policy"]').trigger('click')
    await wrapper.get('[data-testid="storage-confirm-policy"]').trigger('click')
    expect(wrapper.emitted('update-policy')?.at(-1)).toEqual([{ maxRecords: 100, maxImageBytes: 268_435_456 }])
    wrapper.unmount()
  })

  it('keeps capacity inputs read-only while history or storage operations are unavailable', async () => {
    const wrapper = mount(StorageManager, {
      props: { ...baseProps, policyEditable: false },
    })

    for (const testId of ['storage-max-records', 'storage-max-image-bytes', 'storage-apply-policy']) {
      expect(wrapper.get<HTMLInputElement | HTMLButtonElement>(`[data-testid="${testId}"]`).element.disabled).toBe(true)
    }
    await wrapper.get('[data-testid="storage-apply-policy"]').trigger('click')
    expect(wrapper.emitted('update-policy')).toBeUndefined()

    await wrapper.setProps({ policyEditable: true, busyOperation: 'compact' })
    for (const testId of ['storage-max-records', 'storage-max-image-bytes', 'storage-apply-policy']) {
      expect(wrapper.get<HTMLInputElement | HTMLButtonElement>(`[data-testid="${testId}"]`).element.disabled).toBe(true)
    }
  })

  it('warns that backups are unencrypted and delegates file selection to native operations', async () => {
    const wrapper = mount(StorageManager, { props: baseProps })

    const warning = wrapper.get('[data-testid="storage-backup-warning"]').text()
    expect(warning).toContain('not encrypted')
    expect(warning).toContain('sensitive clipboard text, images, and file paths')
    expect(warning).toContain('where to store')
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)

    await wrapper.get('[data-testid="storage-backup"]').trigger('click')
    await wrapper.get('[data-testid="storage-prepare-restore"]').trigger('click')
    await wrapper.get('[data-testid="storage-compact"]').trigger('click')
    await wrapper.get('[data-testid="storage-refresh"]').trigger('click')

    expect(wrapper.emitted('backup')).toHaveLength(1)
    expect(wrapper.emitted('prepare-restore')).toHaveLength(1)
    expect(wrapper.emitted('compact')).toHaveLength(1)
    expect(wrapper.emitted('refresh')).toHaveLength(1)
    expect(wrapper.get('[data-testid="storage-compact-note"]').text()).toContain('does not guarantee a smaller database')
  })

  it('requires an IME-safe destructive confirmation and discards prepared restore state on cancel', async () => {
    const preparedRestore = {
      status: 'prepared' as const,
      token: 'opaque-restore-token',
      currentCount: 8,
      incomingCount: 42,
      schemaVersion: 9,
    }
    const wrapper = mount(StorageManager, {
      props: { ...baseProps, preparedRestore },
    })

    const confirmation = wrapper.get('[data-testid="storage-restore-confirmation"]')
    expect(confirmation.attributes('role')).toBe('alertdialog')
    expect(confirmation.text()).toContain('42 incoming records')
    expect(confirmation.text()).toContain('8 current records')
    expect(confirmation.text()).toContain('schema 9')
    expect(confirmation.text()).toContain('permanently replace all current clipboard history')
    expect(wrapper.text()).not.toContain(preparedRestore.token)

    await confirmation.trigger('compositionstart')
    await wrapper.get('[data-testid="storage-commit-restore"]').trigger('click')
    expect(wrapper.emitted('commit-restore')).toBeUndefined()

    await confirmation.trigger('compositionend')
    await wrapper.get('[data-testid="storage-commit-restore"]').trigger('click')
    expect(wrapper.emitted('commit-restore')?.at(-1)).toEqual([preparedRestore.token])

    await wrapper.get('[data-testid="storage-discard-restore"]').trigger('click')
    expect(wrapper.emitted('discard-restore')?.at(-1)).toEqual([preparedRestore.token])
  })

  it('disables duplicate operations while busy and restores focus when the operation settles', async () => {
    const wrapper = mount(StorageManager, {
      attachTo: document.body,
      props: baseProps,
    })
    const backup = wrapper.get<HTMLButtonElement>('[data-testid="storage-backup"]')
    backup.element.focus()
    await backup.trigger('click')

    await wrapper.setProps({ busyOperation: 'backup' })
    expect(wrapper.get('[data-testid="storage-manager"]').attributes('aria-busy')).toBe('true')
    for (const testId of ['storage-backup', 'storage-prepare-restore', 'storage-compact', 'storage-refresh']) {
      expect(wrapper.get<HTMLButtonElement>(`[data-testid="${testId}"]`).element.disabled).toBe(true)
    }

    await wrapper.setProps({ busyOperation: null, statusMessage: 'Backup cancelled. Existing data was unchanged.' })
    expect(document.activeElement).toBe(backup.element)
    const status = wrapper.get('[data-testid="storage-status"]')
    expect(status.attributes('role')).toBe('status')
    expect(status.attributes('aria-live')).toBe('polite')
    expect(status.text()).toContain('Backup cancelled')
    wrapper.unmount()
  })

  it('renders only closed recovery reasons and a confirmed quarantine path', async () => {
    const quarantinePath = 'C:\\QuickPaste\\recovery\\history-20260719.db'
    const wrapper = mount(StorageManager, {
      props: {
        ...baseProps,
        health: { status: 'recovered' as const, reason: 'notADatabase' as const, quarantinePath },
      },
    })

    const recovered = wrapper.get('[data-testid="storage-recovery-notice"]')
    expect(recovered.attributes('role')).toBe('alert')
    expect(recovered.text()).toContain('was not a SQLite database')
    expect(recovered.text()).toContain(quarantinePath)

    await wrapper.setProps({ health: { status: 'readOnlyError', reason: 'diskFull' } })
    expect(wrapper.find('[data-testid="storage-recovery-notice"]').exists()).toBe(false)
    const error = wrapper.get('[data-testid="storage-health-error"]')
    expect(error.text()).toContain('disk is full')
    expect(error.text()).not.toContain(quarantinePath)

    const freshFailurePath = 'C:\\QuickPaste\\recovery\\history-quarantined.db'
    await wrapper.setProps({
      health: {
        status: 'readOnlyError',
        reason: 'freshDatabaseFailed',
        recoveryReason: 'corrupt',
        quarantinePath: freshFailurePath,
      },
    })
    expect(wrapper.get('[data-testid="storage-health-error"]').text()).toContain(freshFailurePath)
    expect(wrapper.get('[data-testid="storage-health-error"]').text()).toContain('SQLite confirmed')

    await wrapper.setProps({ health: { status: 'healthy' } })
    expect(wrapper.find('[data-testid="storage-health-error"]').exists()).toBe(false)
  })

  it('disables live-database operations in read-only health while keeping refresh available', async () => {
    const wrapper = mount(StorageManager, {
      props: {
        ...baseProps,
        health: { status: 'readOnlyError' as const, reason: 'permissionDenied' as const },
      },
    })

    for (const testId of ['storage-backup', 'storage-prepare-restore', 'storage-compact']) {
      expect(wrapper.get<HTMLButtonElement>(`[data-testid="${testId}"]`).element.disabled).toBe(true)
      await wrapper.get(`[data-testid="${testId}"]`).trigger('click')
    }
    expect(wrapper.emitted('backup')).toBeUndefined()
    expect(wrapper.emitted('prepare-restore')).toBeUndefined()
    expect(wrapper.emitted('compact')).toBeUndefined()
    expect(wrapper.get<HTMLButtonElement>('[data-testid="storage-refresh"]').element.disabled).toBe(false)
  })

  it('has dedicated light, dark, compact 640px, and forced-color presentation', () => {
    expect(styles).toMatch(/\.storage-manager\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/)
    expect(styles).toMatch(/\.storage-panel\s*\{[\s\S]*?background:\s*var\(--surface-raised\)/)
    expect(styles).toMatch(/:root\[data-theme="dark"\]\s+\.storage-manager/)
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.storage-physical-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(styles).toMatch(/@media \(forced-colors:\s*active\)[\s\S]*?\.storage-panel/)
  })

  it('labels pending work and moves focus into and back out of restore confirmation', async () => {
    const wrapper = mount(StorageManager, {
      attachTo: document.body,
      props: { ...baseProps, busyOperation: 'compact' },
    })
    expect(wrapper.get('[data-testid="storage-compact"]').text()).toContain('Compacting')
    expect(wrapper.get('[data-testid="storage-status"]').text()).toContain('Compacting')

    const preparedRestore = {
      status: 'prepared' as const,
      token: 'focus-token',
      currentCount: 8,
      incomingCount: 12,
      schemaVersion: 9,
    }
    await wrapper.setProps({ busyOperation: null, preparedRestore })
    const confirm = wrapper.get<HTMLButtonElement>('[data-testid="storage-commit-restore"]')
    expect(document.activeElement).toBe(confirm.element)

    await wrapper.get('[data-testid="storage-discard-restore"]').trigger('click')
    expect(document.activeElement).toBe(wrapper.get('[data-testid="storage-prepare-restore"]').element)
    wrapper.unmount()
  })
})
