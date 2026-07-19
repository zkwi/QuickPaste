import { mount } from '@vue/test-utils'
import SourceAppIcon from './SourceAppIcon.vue'

describe('SourceAppIcon', () => {
  it('renders a source icon as a decorative image', () => {
    const wrapper = mount(SourceAppIcon, {
      props: {
        source: 'WeChat',
        icon: 'data:image/png;base64,AA==',
      },
    })

    const image = wrapper.get('img')
    expect(image.attributes('src')).toBe('data:image/png;base64,AA==')
    expect(image.attributes('alt')).toBe('')
    expect(image.attributes('aria-hidden')).toBe('true')
  })

  it('falls back to the first Unicode character and applies the fallback color', () => {
    const wrapper = mount(SourceAppIcon, {
      props: {
        source: '  🧪 Laboratory',
        fallbackColor: '#337c74',
      },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="source-app-icon-fallback"]').text()).toBe('🧪')
    expect(wrapper.get('.source-app-icon').attributes('style')).toContain('--source-app-icon-fallback-color: #337c74')
  })

  it('keeps a combined emoji grapheme intact in the fallback', () => {
    const wrapper = mount(SourceAppIcon, {
      props: {
        source: '  👩🏽‍💻 Studio',
      },
    })

    expect(wrapper.get('[data-testid="source-app-icon-fallback"]').text()).toBe('👩🏽‍💻')
  })

  it('falls back after an icon fails to load', async () => {
    const wrapper = mount(SourceAppIcon, {
      props: {
        source: 'notepad',
        icon: 'broken-icon',
      },
    })

    await wrapper.get('img').trigger('error')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="source-app-icon-fallback"]').text()).toBe('N')
  })

  it('retries rendering when the icon or source changes', async () => {
    const wrapper = mount(SourceAppIcon, {
      props: {
        source: 'Notepad',
        icon: 'broken-icon',
      },
    })

    await wrapper.get('img').trigger('error')
    await wrapper.setProps({ icon: 'replacement-icon' })
    expect(wrapper.get('img').attributes('src')).toBe('replacement-icon')

    await wrapper.get('img').trigger('error')
    await wrapper.setProps({ source: '微信' })
    expect(wrapper.get('img').attributes('src')).toBe('replacement-icon')
  })
})
