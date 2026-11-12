<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ClipboardPaste, Copy, ExternalLink, Eye, FolderOpen, Pin, PinOff, Save, ShieldOff, Trash2 } from 'lucide-vue-next'
import type { ClipboardItem } from '../domain/clipboard'
import { getClipActions, type ClipAction, type ClipActionId } from '../domain/clipActions'
import { translate, type Locale } from '../i18n'

type ContextMenuSurface = 'quick' | 'manager' | 'preview'

const props = defineProps<{
  clip: ClipboardItem
  surface: ContextMenuSurface
  locale: Locale
  x: number
  y: number
  pasteDisabled: boolean
}>()

const emit = defineEmits<{
  close: [restoreFocus: boolean]
  action: [action: ClipAction]
  preview: []
}>()

const MENU_MARGIN = 6
const POINTER_GAP = 2
const FALLBACK_WIDTH = 204
const FALLBACK_ITEM_HEIGHT = 38
const menuElement = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const menuHeight = ref<string>()

const showPreview = computed(() => props.surface === 'quick')
const actions = computed(() => getClipActions(props.clip, props.surface))
const menuLabel = computed(() => translate(props.locale, 'clipActions', { title: props.clip.title }))

const actionLabels: Record<ClipActionId, Parameters<typeof translate>[1]> = {
  paste: 'paste',
  'paste-preserve': 'pastePreserve',
  'paste-plain': 'pastePlain',
  copy: 'copyContent',
  'open-link': 'openLink',
  'open-file': 'openFile',
  'reveal-file': 'revealFile',
  'save-image': 'saveImage',
  pin: 'pinClip',
  unpin: 'unpin',
  delete: 'deleteClip',
  'exclude-source': 'excludeSourceApp',
}

function actionIcon(action: ClipAction) {
  if (action.id === 'copy') return Copy
  if (action.id === 'open-link') return ExternalLink
  if (action.id === 'open-file' || action.id === 'reveal-file') return FolderOpen
  if (action.id === 'save-image') return Save
  if (action.id === 'pin') return Pin
  if (action.id === 'unpin') return PinOff
  if (action.id === 'delete') return Trash2
  if (action.id === 'exclude-source') return ShieldOff
  return ClipboardPaste
}

function actionShortcut(action: ClipAction): string | null {
  if (action.id === 'copy') return 'Ctrl+C'
  if (action.id === 'delete') return 'Del'
  return action.id === 'paste' || action.id === 'paste-preserve' ? 'Enter' : null
}

function menuBounds(): DOMRect {
  const selector = props.surface === 'manager' ? '.library-shell' : '.quick-panel'
  const shellBounds = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
  if (shellBounds && shellBounds.width > 0 && shellBounds.height > 0) return shellBounds
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

function placeMenu() {
  const menu = menuElement.value
  if (!menu) return
  const bounds = menuBounds()
  menuHeight.value = `${Math.max(0, bounds.height - 2 * MENU_MARGIN)}px`
  const width = menu.offsetWidth || FALLBACK_WIDTH
  const height = Math.min(bounds.height - 2 * MENU_MARGIN,
    menu.offsetHeight || ((actions.value.length + Number(showPreview.value)) * FALLBACK_ITEM_HEIGHT + 12))
  const minLeft = bounds.left + MENU_MARGIN
  const minTop = bounds.top + MENU_MARGIN
  const maxLeft = Math.max(minLeft, bounds.right - width - MENU_MARGIN)
  const maxTop = Math.max(minTop, bounds.bottom - height - MENU_MARGIN)
  const desiredLeft = props.x + POINTER_GAP + width <= bounds.right - MENU_MARGIN
    ? props.x + POINTER_GAP
    : props.x - width - POINTER_GAP
  const desiredTop = props.y + POINTER_GAP + height <= bounds.bottom - MENU_MARGIN
    ? props.y + POINTER_GAP
    : props.y - height - POINTER_GAP
  left.value = Math.min(Math.max(desiredLeft, minLeft), maxLeft)
  top.value = Math.min(Math.max(desiredTop, minTop), maxTop)
}

function menuItems(): HTMLButtonElement[] {
  return [...(menuElement.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
}

function focusFirstItem() {
  menuItems()[0]?.focus({ preventScroll: true })
}

function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing) {
    // 组合态的 Enter/Space 在真实浏览器里仍可能触发 button 默认 click。
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
    }
    return
  }
  const items = menuItems()
  const currentIndex = items.findIndex((item) => item === document.activeElement)
  const target = event.target instanceof HTMLElement ? event.target : null

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close', true)
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    event.stopPropagation()
    emit('close', true)
    return
  }
  if (event.key === ' ' && target?.dataset.testid === 'context-preview') {
    event.preventDefault()
    event.stopPropagation()
    emit('preview')
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return

  event.preventDefault()
  event.stopPropagation()
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : event.key === 'ArrowDown'
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length
  items[nextIndex]?.focus()
}

onMounted(() => {
  placeMenu()
  focusFirstItem()
})

watch(() => [props.clip.id, props.surface, props.x, props.y], () => {
  placeMenu()
  focusFirstItem()
})
</script>

<template>
  <section
    ref="menuElement"
    data-testid="clip-context-menu"
    class="clip-context-menu"
    role="menu"
    :aria-label="menuLabel"
    :style="{ maxHeight: menuHeight, left: `${left}px`, top: `${top}px` }"
    @keydown="handleKeydown"
  >
    <button
      v-for="action in actions"
      :key="action.id"
      :data-testid="`context-${action.id}`"
      role="menuitem"
      :class="{ danger: action.id === 'delete' }"
      type="button"
      :disabled="action.disabled || (Boolean(action.pasteMode) && pasteDisabled)"
      @click="emit('action', action)"
    >
      <component :is="actionIcon(action)" :size="15" aria-hidden="true" />
      <span>{{ translate(locale, actionLabels[action.id]) }}</span>
      <kbd v-if="actionShortcut(action)">{{ actionShortcut(action) }}</kbd>
    </button>
    <button v-if="showPreview" data-testid="context-preview" role="menuitem" type="button" @click="emit('preview')">
      <Eye :size="15" aria-hidden="true" />
      <span>{{ translate(locale, 'preview') }}</span>
      <kbd>Space</kbd>
    </button>
  </section>
</template>
