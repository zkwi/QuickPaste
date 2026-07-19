<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ClipboardPaste, Copy, Eye, Pin, Trash2 } from 'lucide-vue-next'
import type { ClipboardItem } from '../domain/clipboard'
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
  paste: []
  copy: []
  preview: []
  pin: []
  delete: []
}>()

const MENU_MARGIN = 6
const POINTER_GAP = 2
const FALLBACK_WIDTH = 204
const FALLBACK_QUICK_HEIGHT = 180
const FALLBACK_MANAGER_HEIGHT = 146
const menuElement = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)

const showPreview = computed(() => props.surface === 'quick')
const menuLabel = computed(() => translate(props.locale, 'clipActions', { title: props.clip.title }))

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
  const width = menu.offsetWidth || FALLBACK_WIDTH
  const height = menu.offsetHeight || (showPreview.value ? FALLBACK_QUICK_HEIGHT : FALLBACK_MANAGER_HEIGHT)
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
  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'c') {
    event.preventDefault()
    event.stopPropagation()
    emit('copy')
    return
  }
  if (event.key === 'Delete') {
    event.preventDefault()
    event.stopPropagation()
    emit('delete')
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
  items[nextIndex]?.focus({ preventScroll: true })
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
    :style="{ left: `${left}px`, top: `${top}px` }"
    @keydown="handleKeydown"
  >
    <button data-testid="context-paste" role="menuitem" type="button" :disabled="pasteDisabled" @click="emit('paste')">
      <ClipboardPaste :size="15" aria-hidden="true" />
      <span>{{ translate(locale, 'paste') }}</span>
      <kbd>Enter</kbd>
    </button>
    <button data-testid="context-copy" role="menuitem" type="button" @click="emit('copy')">
      <Copy :size="15" aria-hidden="true" />
      <span>{{ translate(locale, 'copyContent') }}</span>
      <kbd>Ctrl C</kbd>
    </button>
    <button v-if="showPreview" data-testid="context-preview" role="menuitem" type="button" @click="emit('preview')">
      <Eye :size="15" aria-hidden="true" />
      <span>{{ translate(locale, 'preview') }}</span>
      <kbd>Space</kbd>
    </button>
    <div class="context-menu-separator" role="separator"></div>
    <button data-testid="context-pin" role="menuitem" type="button" @click="emit('pin')">
      <Pin :size="15" :fill="clip.pinned ? 'currentColor' : 'none'" aria-hidden="true" />
      <span>{{ translate(locale, clip.pinned ? 'unpin' : 'pinClip') }}</span>
    </button>
    <div class="context-menu-separator" role="separator"></div>
    <button data-testid="context-delete" class="danger" role="menuitem" type="button" @click="emit('delete')">
      <Trash2 :size="15" aria-hidden="true" />
      <span>{{ translate(locale, 'deleteClip') }}</span>
      <kbd>Del</kbd>
    </button>
  </section>
</template>
