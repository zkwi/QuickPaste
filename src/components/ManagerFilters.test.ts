import { mount } from '@vue/test-utils'
import ManagerFilters from './ManagerFilters.vue'

describe('ManagerFilters', () => {
  it('emits deterministic kind, exact-source, and pinned filters', async () => {
    const wrapper = mount(ManagerFilters, {
      props: {
        kinds: [],
        sourceApp: '',
        pinned: undefined,
        locale: 'zh-CN',
      },
    })

    await wrapper.get('[data-testid="manager-kind-text"]').trigger('click')
    expect(wrapper.emitted('update:kinds')?.at(-1)).toEqual([['text']])

    await wrapper.setProps({ kinds: ['text'] })
    await wrapper.get('[data-testid="manager-kind-image"]').trigger('click')
    expect(wrapper.emitted('update:kinds')?.at(-1)).toEqual([['text', 'image']])

    await wrapper.get('[data-testid="manager-source-filter"]').setValue('Visual Studio Code')
    expect(wrapper.emitted('update:sourceApp')?.at(-1)).toEqual(['Visual Studio Code'])

    await wrapper.get('[data-testid="manager-pinned-filter"]').setValue('unpinned')
    expect(wrapper.emitted('update:pinned')?.at(-1)).toEqual([false])
  })

  it('clears every filter without presenting page-local sources as a complete facet', async () => {
    const wrapper = mount(ManagerFilters, {
      props: {
        kinds: ['code'],
        sourceApp: 'Terminal',
        pinned: true,
        locale: 'en-US',
      },
    })

    expect(wrapper.find('select[multiple]').exists()).toBe(false)
    await wrapper.get('[data-testid="reset-manager-filters"]').trigger('click')

    expect(wrapper.emitted('update:kinds')?.at(-1)).toEqual([[]])
    expect(wrapper.emitted('update:sourceApp')?.at(-1)).toEqual([''])
    expect(wrapper.emitted('update:pinned')?.at(-1)).toEqual([undefined])
  })
})
