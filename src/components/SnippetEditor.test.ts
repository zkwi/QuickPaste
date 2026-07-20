import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { vi } from 'vitest'
import SnippetEditor from './SnippetEditor.vue'

const styles = readFileSync('src/style.css', 'utf8')

const baseProps = {
  locale: 'en-US' as const,
  modelValue: {
    title: 'Deployment note',
    content: 'npm run build',
    kind: 'code' as const,
  },
  collections: [{
    id: 'work',
    name: 'Work',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    sortOrder: 0,
  }],
  busy: false,
  errorMessage: '',
}

describe('SnippetEditor', () => {
  it('renders a manager-only plain-text snippet draft with kind and one-level collection fields', () => {
    const wrapper = mount(SnippetEditor, { props: baseProps })

    expect(wrapper.get('[data-testid="snippet-editor"]').attributes('role')).toBe('dialog')
    expect(wrapper.get('[data-testid="snippet-editor-title"]').text()).toContain('Create snippet')
    expect(wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]').element.value)
      .toBe('Deployment note')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="snippet-content"]').element.value)
      .toBe('npm run build')
    expect(wrapper.get<HTMLSelectElement>('[data-testid="snippet-kind"]').element.value).toBe('code')
    expect(wrapper.get('[data-testid="snippet-collection"]').text()).toContain('Unfiled')
    expect(wrapper.get('[data-testid="snippet-collection"]').text()).toContain('Work')
    expect(wrapper.find('[contenteditable="true"]').exists()).toBe(false)
  })

  it('keeps edit identity, emits draft updates, and saves only normalized plain-text fields', async () => {
    const wrapper = mount(SnippetEditor, {
      props: {
        ...baseProps,
        modelValue: {
          id: 'snippet-1',
          title: 'Old title',
          content: 'Old body',
          kind: 'code',
          html: '<b>stale</b>',
          rtf: '{\\rtf1 stale}',
        } as typeof baseProps.modelValue & { id: string; html: string; rtf: string },
      },
    })
    expect(wrapper.get('[data-testid="snippet-editor-title"]').text()).toContain('Edit snippet')

    await wrapper.get('[data-testid="snippet-title"]').setValue('  Updated title  ')
    await wrapper.get('[data-testid="snippet-content"]').setValue('line 1\nline 2')
    await wrapper.get('[data-testid="snippet-kind"]').setValue('text')
    await wrapper.get('[data-testid="snippet-collection"]').setValue('collection:work')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([{
      id: 'snippet-1',
      title: '  Updated title  ',
      content: 'line 1\nline 2',
      collectionId: 'work',
      kind: 'text',
    }])

    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')?.at(-1)).toEqual([{
      id: 'snippet-1',
      title: 'Updated title',
      content: 'line 1\nline 2',
      collectionId: 'work',
      kind: 'text',
    }])
  })

  it('keeps invalid drafts visible and explains title, body, and missing-collection errors', async () => {
    const wrapper = mount(SnippetEditor, { props: baseProps })

    await wrapper.get('[data-testid="snippet-title"]').setValue('   ')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.get('[data-testid="snippet-validation-error"]').text()).toContain('title')
    expect(wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]').element.value).toBe('   ')

    await wrapper.get('[data-testid="snippet-title"]').setValue('Title')
    await wrapper.get('[data-testid="snippet-content"]').setValue('  ')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.get('[data-testid="snippet-validation-error"]').text()).toContain('content')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="snippet-content"]').element.value).toBe('  ')

    await wrapper.get('[data-testid="snippet-content"]').setValue('Body')
    await wrapper.get('[data-testid="snippet-collection"]').setValue('collection:work')
    await wrapper.setProps({ collections: [] })
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.get('[data-testid="snippet-validation-error"]').text()).toContain('collection')
    expect(wrapper.get<HTMLSelectElement>('[data-testid="snippet-collection"]').element.value)
      .toBe('collection:work')
  })

  it('returns the current draft on cancel and preserves it through native failure and busy state', async () => {
    const wrapper = mount(SnippetEditor, { props: baseProps })
    await wrapper.get('[data-testid="snippet-title"]').setValue('Unsaved title')
    await wrapper.get('[data-testid="snippet-content"]').setValue('Unsaved body')
    await wrapper.get('[data-testid="snippet-cancel"]').trigger('click')

    expect(wrapper.emitted('cancel')?.at(-1)).toEqual([{
      title: 'Unsaved title',
      content: 'Unsaved body',
      kind: 'code',
    }])
    expect(wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]').element.value)
      .toBe('Unsaved title')

    await wrapper.setProps({ errorMessage: 'Saving failed. The draft was kept.' })
    expect(wrapper.get('[data-testid="snippet-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="snippet-error"]').text()).toContain('draft was kept')
    expect(wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]').element.value)
      .toBe('Unsaved title')

    await wrapper.setProps({ busy: true })
    expect(wrapper.get('[data-testid="snippet-editor"]').attributes('aria-busy')).toBe('true')
    for (const testId of [
      'snippet-title',
      'snippet-content',
      'snippet-kind',
      'snippet-collection',
      'snippet-cancel',
      'snippet-save',
    ]) {
      expect(wrapper.get<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      ).element.disabled).toBe(true)
    }
    await wrapper.get('form').trigger('submit')
    await wrapper.get('[data-testid="snippet-cancel"]').trigger('click')
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('resets local state when snippet identity changes without overwriting same-identity unsaved edits', async () => {
    const wrapper = mount(SnippetEditor, {
      props: {
        ...baseProps,
        modelValue: {
          id: 'snippet-a',
          title: 'Snippet A',
          content: 'Body A',
          kind: 'text',
        },
      },
    })
    await wrapper.get('[data-testid="snippet-title"]').setValue('Unsaved A')
    const updateCount = wrapper.emitted('update:modelValue')?.length ?? 0

    await wrapper.setProps({
      modelValue: {
        id: 'snippet-b',
        title: 'Snippet B',
        content: 'Body B',
        collectionId: 'work',
        kind: 'code',
      },
    })
    expect(wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]').element.value).toBe('Snippet B')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="snippet-content"]').element.value).toBe('Body B')
    expect(wrapper.get<HTMLSelectElement>('[data-testid="snippet-kind"]').element.value).toBe('code')
    expect(wrapper.get<HTMLSelectElement>('[data-testid="snippet-collection"]').element.value)
      .toBe('collection:work')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(updateCount)

    await wrapper.get('[data-testid="snippet-title"]').setValue('Unsaved B')
    await wrapper.setProps({
      modelValue: {
        id: 'snippet-b',
        title: 'Stale parent echo',
        content: 'Body B',
        kind: 'code',
      },
      errorMessage: 'Save failed',
    })
    expect(wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]').element.value).toBe('Unsaved B')

    await wrapper.setProps({
      modelValue: {
        title: 'New draft',
        content: 'New body',
        kind: 'text',
      },
      errorMessage: '',
    })
    expect(wrapper.get('[data-testid="snippet-editor-title"]').text()).toContain('Create snippet')
    expect(wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]').element.value).toBe('New draft')
  })

  it('moves focus into the dialog, traps it, and restores the original manager control on unmount', async () => {
    const host = document.createElement('div')
    const trigger = document.createElement('button')
    host.append(trigger)
    document.body.append(host)
    trigger.focus()

    const wrapper = mount(SnippetEditor, { attachTo: host, props: baseProps })
    await nextTick()
    const title = wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]')
    const save = wrapper.get<HTMLButtonElement>('[data-testid="snippet-save"]')
    expect(document.activeElement).toBe(title.element)

    title.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }))
    expect(document.activeElement).toBe(save.element)
    save.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }))
    expect(document.activeElement).toBe(title.element)

    wrapper.unmount()
    expect(document.activeElement).toBe(trigger)
    host.remove()
  })

  it('keeps native Ctrl+A, Space, and textarea Enter while handling save and Escape with IME priority', async () => {
    const wrapper = mount(SnippetEditor, { attachTo: document.body, props: baseProps })
    const editor = wrapper.get('[data-testid="snippet-editor"]')
    const title = wrapper.get<HTMLInputElement>('[data-testid="snippet-title"]')
    const content = wrapper.get<HTMLTextAreaElement>('[data-testid="snippet-content"]')
    const outerKeydown = vi.fn()
    document.body.addEventListener('keydown', outerKeydown)

    await editor.trigger('compositionstart')
    title.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))
    title.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toBeUndefined()
    await editor.trigger('compositionend')

    const selectAll = new KeyboardEvent('keydown', {
      key: 'a', ctrlKey: true, bubbles: true, cancelable: true,
    })
    title.element.dispatchEvent(selectAll)
    expect(selectAll.defaultPrevented).toBe(false)

    const space = new KeyboardEvent('keydown', {
      key: ' ', bubbles: true, cancelable: true,
    })
    content.element.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(false)

    const textareaEnter = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    })
    content.element.dispatchEvent(textareaEnter)
    expect(textareaEnter.defaultPrevented).toBe(false)
    expect(wrapper.emitted('save')).toBeUndefined()

    const titleEnter = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    })
    title.element.dispatchEvent(titleEnter)
    expect(titleEnter.defaultPrevented).toBe(true)
    expect(wrapper.emitted('save')).toHaveLength(1)

    const controlEnter = new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    })
    content.element.dispatchEvent(controlEnter)
    expect(controlEnter.defaultPrevented).toBe(true)
    expect(wrapper.emitted('save')).toHaveLength(2)

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })
    title.element.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(outerKeydown).not.toHaveBeenCalled()

    document.body.removeEventListener('keydown', outerKeydown)
    wrapper.unmount()
  })

  it('has a bounded, scrollable, compact, dark-theme, focus, and forced-color dialog', () => {
    expect(styles).toMatch(/\.snippet-editor-backdrop\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/)
    expect(styles).toMatch(/\.snippet-editor\s*\{[\s\S]*?max-height:[\s\S]*?overflow:\s*auto/)
    expect(styles).toMatch(/:root\[data-theme="dark"\]\s+\.snippet-editor/)
    expect(styles).toMatch(/\.snippet-editor[\s\S]*?:focus-visible/)
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.snippet-editor-selects/)
    expect(styles).toMatch(/@media \(forced-colors:\s*active\)[\s\S]*?\.snippet-editor/)
  })
})
