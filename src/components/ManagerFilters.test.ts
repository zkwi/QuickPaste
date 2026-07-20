import { mount } from '@vue/test-utils'
import ManagerFilters from './ManagerFilters.vue'

describe('ManagerFilters', () => {
  it('keeps only the useful kind filters and emits them deterministically', async () => {
    const wrapper = mount(ManagerFilters, {
      props: {
        kinds: [],
        locale: 'zh-CN',
      },
    })

    expect(wrapper.get('[data-testid="manager-kind-all"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[data-testid="manager-kind-text"]').trigger('click')
    expect(wrapper.emitted('update:kinds')?.at(-1)).toEqual([['text']])

    await wrapper.setProps({ kinds: ['text'] })
    await wrapper.get('[data-testid="manager-kind-image"]').trigger('click')
    expect(wrapper.emitted('update:kinds')?.at(-1)).toEqual([['text', 'image']])

    await wrapper.get('[data-testid="manager-kind-all"]').trigger('click')
    expect(wrapper.emitted('update:kinds')?.at(-1)).toEqual([[]])
  })

  it('does not repeat source or pinned filters already covered by search and navigation', () => {
    const wrapper = mount(ManagerFilters, {
      props: {
        kinds: ['code'],
        locale: 'en-US',
      },
    })

    expect(wrapper.find('[data-testid="manager-source-filter"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="manager-pinned-filter"]').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(6)
  })
})
