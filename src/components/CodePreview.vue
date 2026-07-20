<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { CodePreviewLanguage } from '../domain/codeLanguage'
import { highlightCode } from '../platform/codeHighlight'

const props = defineProps<{
  code: string
  language?: CodePreviewLanguage
}>()

const highlightedHtml = ref('')
const highlighted = ref(false)
let renderGeneration = 0
let mounted = true

async function renderCode() {
  const generation = ++renderGeneration
  highlighted.value = false
  highlightedHtml.value = ''
  const code = props.code
  const language = props.language
  if (!language) return
  const isCurrent = () => mounted
    && generation === renderGeneration
    && props.code === code
    && props.language === language
  const html = await highlightCode(code, language, isCurrent)
  if (html === null || !isCurrent()) return
  highlightedHtml.value = html
  highlighted.value = true
}

watch(
  () => [props.code, props.language] as const,
  () => { void renderCode() },
  { immediate: true },
)

onBeforeUnmount(() => {
  mounted = false
  renderGeneration += 1
})
</script>

<template>
  <pre
    class="code-preview"
    data-testid="code-preview"
    :data-highlighted="highlighted ? 'true' : 'false'"
  ><code v-if="highlighted" class="hljs" v-html="highlightedHtml" /><code v-else>{{ code }}</code></pre>
</template>
