<script setup lang="ts">
import { Image as ImageIcon } from 'lucide-vue-next'
import { ref, watch } from 'vue'
import { loadNativeClipThumbnail } from '../platform/history'

const props = defineProps<{
  clipId: string
  imageUrl?: string
  imageHash?: string
}>()

const cachedThumbnails = new Map<string, string>()
const pendingThumbnails = new Map<string, Promise<string | null>>()
const thumbnailUrl = ref<string>()
let loadGeneration = 0

function thumbnailKey(): string {
  return `${props.clipId}:${props.imageHash ?? ''}`
}

function loadSharedThumbnail(key: string): Promise<string | null> {
  const cached = cachedThumbnails.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = pendingThumbnails.get(key)
  if (pending) return pending

  const request = loadNativeClipThumbnail(props.clipId).then((thumbnail) => {
    if (thumbnail) cachedThumbnails.set(key, thumbnail)
    return thumbnail
  }).finally(() => {
    if (pendingThumbnails.get(key) === request) pendingThumbnails.delete(key)
  })
  pendingThumbnails.set(key, request)
  return request
}

watch(
  () => [props.clipId, props.imageUrl, props.imageHash] as const,
  async () => {
    const generation = ++loadGeneration
    if (props.imageUrl) {
      thumbnailUrl.value = props.imageUrl
      return
    }
    thumbnailUrl.value = undefined
    const key = thumbnailKey()
    const thumbnail = await loadSharedThumbnail(key)
    if (generation === loadGeneration) thumbnailUrl.value = thumbnail ?? undefined
  },
  { immediate: true },
)

function handleImageError() {
  thumbnailUrl.value = undefined
}
</script>

<template>
  <img
    v-if="thumbnailUrl"
    :src="thumbnailUrl"
    alt=""
    aria-hidden="true"
    draggable="false"
    @error="handleImageError"
  />
  <ImageIcon v-else :size="18" aria-hidden="true" />
</template>
