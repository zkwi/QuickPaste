import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import { vi } from 'vitest'
import ManagerBulkToolbar from './ManagerBulkToolbar.vue'

const styles = readFileSync('src/style.css', 'utf8')

const baseProps = {
  locale: 'en-US' as const,
  selectionState: 'none' as const,
  selectedCount: 0,
  collections: [],
  busy: false,
  errorMessage: '',
  includesPinned: false,
  includesPermanent: false,
}

describe('ManagerBulkToolbar', () => {
  it('exposes none, mixed, and all selection states with a live selected-count announcement', async () => {
    const wrapper = mount(ManagerBulkToolbar, { props: baseProps })
    const checkbox = wrapper.get<HTMLInputElement>('[data-testid="manager-select-all"]')

    expect(checkbox.element.checked).toBe(false)
    expect(checkbox.element.indeterminate).toBe(false)
    expect(checkbox.attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('0 selected')

    await wrapper.setProps({ selectionState: 'mixed', selectedCount: 3 })
    expect(checkbox.element.checked).toBe(false)
    expect(checkbox.element.indeterminate).toBe(true)
    expect(checkbox.attributes('aria-checked')).toBe('mixed')
    expect(wrapper.get('[data-testid="manager-selected-count"]').attributes('aria-live')).toBe('polite')
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('3 selected')

    await wrapper.setProps({ selectionState: 'all', selectedCount: 8 })
    expect(checkbox.element.checked).toBe(true)
    expect(checkbox.element.indeterminate).toBe(false)
    expect(checkbox.attributes('aria-checked')).toBe('true')
  })

  it('requests all matching selection and emits explicit move, pin, and unpin actions', async () => {
    const wrapper = mount(ManagerBulkToolbar, {
      props: {
        ...baseProps,
        collections: [{
          id: 'collection-work',
          name: 'Work',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
          sortOrder: 0,
        }],
      },
    })

    await wrapper.get('[data-testid="manager-select-all"]').trigger('change')
    expect(wrapper.emitted('select-all')).toHaveLength(1)

    await wrapper.setProps({ selectionState: 'all', selectedCount: 7 })
    await wrapper.get('[data-testid="manager-select-all"]').trigger('change')
    expect(wrapper.emitted('clear-selection')).toHaveLength(1)

    await wrapper.get('[data-testid="manager-move-target"]').setValue('collection:collection-work')
    await wrapper.get('[data-testid="manager-apply-move"]').trigger('click')
    expect(wrapper.emitted('apply')?.at(-1)).toEqual([{
      type: 'move',
      collectionId: 'collection-work',
    }])

    await wrapper.get('[data-testid="manager-move-target"]').setValue('unfiled')
    await wrapper.get('[data-testid="manager-apply-move"]').trigger('click')
    expect(wrapper.emitted('apply')?.at(-1)).toEqual([{ type: 'move', collectionId: null }])

    await wrapper.get('[data-testid="manager-pin"]').trigger('click')
    await wrapper.get('[data-testid="manager-unpin"]').trigger('click')
    expect(wrapper.emitted('apply')?.slice(-2)).toEqual([
      [{ type: 'setPinned', pinned: true }],
      [{ type: 'setPinned', pinned: false }],
    ])
  })

  it('requires an IME-safe confirmation before deleting pinned or permanent records', async () => {
    const wrapper = mount(ManagerBulkToolbar, {
      attachTo: document.body,
      props: {
        ...baseProps,
        selectionState: 'mixed',
        selectedCount: 3,
        includesPinned: true,
        includesPermanent: true,
      },
    })
    const deleteButton = wrapper.get<HTMLButtonElement>('[data-testid="manager-delete"]')
    deleteButton.element.focus()
    await deleteButton.trigger('click')

    expect(wrapper.emitted('apply')).toBeUndefined()
    const confirmation = wrapper.get('[data-testid="manager-delete-confirmation"]')
    expect(confirmation.attributes('role')).toBe('alertdialog')
    expect(confirmation.text()).toContain('3')
    expect(confirmation.text()).toContain('pinned')
    expect(confirmation.text()).toContain('permanent')
    const confirm = wrapper.get<HTMLButtonElement>('[data-testid="manager-confirm-delete"]')
    expect(document.activeElement).toBe(confirm.element)

    await confirmation.trigger('compositionstart')
    await confirm.trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()

    await confirmation.trigger('compositionend')
    await confirm.trigger('click')
    expect(wrapper.emitted('apply')?.at(-1)).toEqual([{ type: 'delete' }])

    await wrapper.setProps({ busy: true })
    await confirm.trigger('click')
    expect(wrapper.emitted('apply')).toHaveLength(1)
    wrapper.unmount()
  })

  it('closes delete confirmation on Escape and restores focus without clearing selection', async () => {
    const wrapper = mount(ManagerBulkToolbar, {
      attachTo: document.body,
      props: { ...baseProps, selectionState: 'mixed', selectedCount: 2 },
    })
    const deleteButton = wrapper.get<HTMLButtonElement>('[data-testid="manager-delete"]')
    deleteButton.element.focus()
    await deleteButton.trigger('click')
    const outerKeydown = vi.fn()
    document.body.addEventListener('keydown', outerKeydown)

    await wrapper.get('[data-testid="manager-delete-confirmation"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.find('[data-testid="manager-delete-confirmation"]').exists()).toBe(false)
    expect(document.activeElement).toBe(deleteButton.element)
    expect(wrapper.emitted('clear-selection')).toBeUndefined()
    expect(outerKeydown).not.toHaveBeenCalled()
    document.body.removeEventListener('keydown', outerKeydown)
    wrapper.unmount()
  })

  it('uses unambiguous move values when a collection id resembles the unfiled sentinel', async () => {
    const wrapper = mount(ManagerBulkToolbar, {
      props: {
        ...baseProps,
        selectionState: 'mixed',
        selectedCount: 1,
        collections: [{
          id: '__unfiled__',
          name: 'Literal sentinel',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
          sortOrder: 0,
        }],
      },
    })

    expect(wrapper.get('[data-testid="manager-bulk-toolbar"]').attributes('role')).toBe('toolbar')
    await wrapper.get('[data-testid="manager-move-target"]').setValue('collection:__unfiled__')
    await wrapper.get('[data-testid="manager-apply-move"]').trigger('click')

    expect(wrapper.emitted('apply')?.at(-1)).toEqual([{
      type: 'move',
      collectionId: '__unfiled__',
    }])
  })

  it('disables duplicate work while busy and preserves selection, destination, and confirmation on failure', async () => {
    const wrapper = mount(ManagerBulkToolbar, {
      props: {
        ...baseProps,
        selectionState: 'mixed',
        selectedCount: 4,
        collections: [{
          id: 'archive',
          name: 'Archive',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
          sortOrder: 0,
        }],
      },
    })
    await wrapper.get('[data-testid="manager-move-target"]').setValue('collection:archive')
    await wrapper.get('[data-testid="manager-delete"]').trigger('click')
    await wrapper.setProps({ busy: true })

    expect(wrapper.get('[data-testid="manager-bulk-toolbar"]').attributes('aria-busy')).toBe('true')
    for (const testId of [
      'manager-select-all',
      'manager-move-target',
      'manager-apply-move',
      'manager-pin',
      'manager-unpin',
      'manager-delete',
      'manager-confirm-delete',
    ]) {
      expect(wrapper.get<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
        `[data-testid="${testId}"]`,
      ).element.disabled).toBe(true)
    }
    await wrapper.get('[data-testid="manager-pin"]').trigger('click')
    await wrapper.get('[data-testid="manager-confirm-delete"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()

    await wrapper.setProps({ busy: false, errorMessage: 'The batch failed. Try again.' })
    expect(wrapper.get<HTMLSelectElement>('[data-testid="manager-move-target"]').element.value)
      .toBe('collection:archive')
    expect(wrapper.find('[data-testid="manager-delete-confirmation"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="manager-selected-count"]').text()).toContain('4 selected')
    expect(wrapper.get('[data-testid="manager-bulk-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="manager-bulk-error"]').text()).toContain('batch failed')
  })

  it('traps focus in delete confirmation while preserving native IME Escape behavior', async () => {
    const wrapper = mount(ManagerBulkToolbar, {
      attachTo: document.body,
      props: { ...baseProps, selectionState: 'mixed', selectedCount: 1 },
    })
    await wrapper.get('[data-testid="manager-delete"]').trigger('click')
    const confirmation = wrapper.get('[data-testid="manager-delete-confirmation"]')
    const cancel = wrapper.get<HTMLButtonElement>('[data-testid="manager-cancel-delete"]')
    const confirm = wrapper.get<HTMLButtonElement>('[data-testid="manager-confirm-delete"]')
    const outerKeydown = vi.fn()
    document.body.addEventListener('keydown', outerKeydown)

    cancel.element.focus()
    await confirmation.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm.element)
    await confirmation.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(cancel.element)

    await confirmation.trigger('compositionstart')
    await confirmation.trigger('keydown', { key: 'Escape', isComposing: true })
    expect(wrapper.find('[data-testid="manager-delete-confirmation"]').exists()).toBe(true)
    expect(outerKeydown).not.toHaveBeenCalled()
    await confirmation.trigger('compositionend')
    document.body.removeEventListener('keydown', outerKeydown)
    wrapper.unmount()
  })

  it('has dedicated compact, dark-theme, modal, focus, and forced-color presentation', () => {
    expect(styles).toMatch(/\.manager-bulk-toolbar\s*\{[\s\S]*?grid-template-columns:/)
    expect(styles).toMatch(/:root\[data-theme="dark"\]\s+\.manager-bulk-toolbar/)
    expect(styles).toMatch(/\.manager-bulk-confirmation-backdrop\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/)
    expect(styles).toMatch(/\.manager-bulk-toolbar[\s\S]*?:focus-visible/)
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.manager-bulk-toolbar/)
    expect(styles).toMatch(/@media \(forced-colors:\s*active\)[\s\S]*?\.manager-bulk-toolbar/)
  })
})
