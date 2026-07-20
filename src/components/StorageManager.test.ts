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
  statusMessage: '',
}

describe('StorageManager', () => {
  it('shows only database size and record count as core statistics', () => {
    const wrapper = mount(StorageManager, { props: baseProps })

    const summary = wrapper.get('[data-testid="storage-summary"]')
    expect(summary.findAll('article')).toHaveLength(2)
    expect(wrapper.get('[data-testid="storage-database-size"]').text()).toContain('MB')
    expect(wrapper.get('[data-testid="storage-record-count"]').text()).toContain('8')
    expect(wrapper.find('[data-testid="storage-wal-bytes"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="storage-policy"]').exists()).toBe(false)
  })

  it('explains the portable data folder and lets the user open it directly', async () => {
    const wrapper = mount(StorageManager, { props: baseProps })

    const location = wrapper.get('[data-testid="storage-data-location"]')
    expect(location.text()).toContain('data folder next to QuickPaste.exe')
    expect(location.text()).toContain('exit QuickPaste completely')

    await wrapper.get('[data-testid="storage-open-directory"]').trigger('click')
    expect(wrapper.emitted('open-data-directory')).toHaveLength(1)
  })

  it('keeps backup details quiet and delegates file selection to native operations', async () => {
    const wrapper = mount(StorageManager, { props: baseProps })

    expect(wrapper.find('[data-testid="storage-backup-warning"]').exists()).toBe(false)
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
      expect(wrapper.get<HTMLButtonElement>('[data-testid="' + testId + '"]').element.disabled).toBe(true)
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
      expect(wrapper.get<HTMLButtonElement>('[data-testid="' + testId + '"]').element.disabled).toBe(true)
      await wrapper.get('[data-testid="' + testId + '"]').trigger('click')
    }
    expect(wrapper.emitted('backup')).toBeUndefined()
    expect(wrapper.emitted('prepare-restore')).toBeUndefined()
    expect(wrapper.emitted('compact')).toBeUndefined()
    expect(wrapper.get<HTMLButtonElement>('[data-testid="storage-refresh"]').element.disabled).toBe(false)
  })

  it('has dedicated light, dark, compact 640px, and forced-color presentation', () => {
    expect(styles).toMatch(/\.storage-manager\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/)
    expect(styles).toMatch(/\.storage-summary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(styles).toMatch(/:root\[data-theme="dark"\]\s+\.storage-manager/)
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.storage-summary\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/)
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
