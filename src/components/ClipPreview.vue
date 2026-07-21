<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import { AlignLeft, ArrowLeft, Code2, Copy, ExternalLink, Image as ImageIcon, LayoutList, Link2, QrCode } from 'lucide-vue-next'
import { defaultPasteMode, getClipActions, type PasteMode } from '../domain/clipActions'
import type { CodePreviewLanguage } from '../domain/codeLanguage'
import { formatRelativeTime, type ClipKind, type LoadedClipboardItem } from '../domain/clipboard'
import { isSafeExternalUrl } from '../domain/externalLink'
import type { Locale, MessageKey } from '../i18n'

type Translator = (key: MessageKey, replacements?: Record<string, string | number>) => string
const CodePreview = defineAsyncComponent(() => import('./CodePreview.vue'))

const props = defineProps<{
  clip: LoadedClipboardItem
  codeLanguage?: CodePreviewLanguage
  qrScanState: 'idle' | 'scanning' | 'complete'
  qrResults: string[]
  pasteInFlight: boolean
  relativeTimeNow: Date
  locale: Locale
  t: Translator
}>()

const emit = defineEmits<{
  close: []
  copyRecognizedText: [text: string, sourceApp: string]
  pasteRecognizedText: [text: string]
  openQrLink: [value: string]
  paste: [mode?: PasteMode]
}>()

const pasteButton = ref<HTMLButtonElement | null>(null)

function kindLabel(kind: ClipKind): string {
  return {
    text: props.t('text'),
    code: props.t('code'),
    link: props.t('link'),
    image: props.t('image'),
    file: '文件',
  }[kind]
}

function kindIcon(kind: ClipKind) {
  return { text: AlignLeft, code: Code2, link: Link2, image: ImageIcon, file: LayoutList }[kind]
}

function focusPrimary() {
  pasteButton.value?.focus()
}

defineExpose({ focusPrimary, primaryButton: () => pasteButton.value })
</script>

<template>
  <section data-testid="preview-panel" :data-preview-clip-id="clip.id" class="preview-panel" :aria-label="t('clipboardPreview')">
    <div class="preview-header">
      <button data-testid="close-preview" class="back-button" type="button" @click="emit('close')"><ArrowLeft :size="17" /> {{ t('backToHistory') }}</button>
      <span v-if="clip.kind === 'image'" class="preview-image-title">{{ clip.title }}</span>
      <span v-else class="preview-type">{{ kindLabel(clip.kind) }}</span>
    </div>
    <div class="preview-body" :class="{ 'image-preview-body': clip.kind === 'image' }">
      <div v-if="clip.kind !== 'image'" class="preview-heading">
        <span class="kind-icon large" :style="{ '--source-color': clip.color }"><component :is="kindIcon(clip.kind)" :size="20" /></span>
        <div><h1>{{ clip.title }}</h1><p>{{ clip.sourceApp }} · {{ formatRelativeTime(clip.copiedAt, relativeTimeNow, locale) }}</p></div>
      </div>
      <div v-if="clip.kind !== 'image' && clip.formats?.length" class="format-badges" :aria-label="clip.formats.join(', ')">
        <span v-for="format in clip.formats" :key="format" class="format-badge">{{ format.toUpperCase() }}</span>
      </div>
      <p v-if="clip.kind !== 'image' && clip.omittedFormats?.length" class="format-omission-warning" role="status">{{ t('omittedFormatsWarning', { formats: clip.omittedFormats.map((format) => format.toUpperCase()).join(', ') }) }}</p>
      <div v-if="clip.kind === 'image'" class="image-preview-content">
        <img class="preview-image" :src="clip.imageUrl" :alt="clip.title" />
        <details v-if="clip.ocrStatus === 'completed' && clip.ocrText" data-testid="preview-ocr-text" class="preview-ocr-text">
          <summary><strong>{{ t('ocrRecognizedText') }}</strong></summary>
          <div class="recognized-text-content">
            <p>{{ clip.ocrText }}</p>
            <span class="recognized-text-actions">
              <button data-testid="copy-ocr-text" type="button" @click="emit('copyRecognizedText', clip.ocrText ?? '', clip.sourceApp)"><Copy :size="12" />{{ t('copyOcrText') }}</button>
              <button data-testid="paste-ocr-text" type="button" :disabled="pasteInFlight" @click="emit('pasteRecognizedText', clip.ocrText ?? '')">{{ t('pasteOcrText') }}</button>
            </span>
          </div>
        </details>
        <section v-if="qrScanState !== 'idle'" class="preview-qr" :aria-label="t('qrCode')" aria-live="polite">
          <p v-if="qrScanState === 'scanning'" class="qr-status"><QrCode :size="13" />{{ t('qrRecognizing') }}</p>
          <p v-else-if="qrResults.length === 0" class="qr-status"><QrCode :size="13" />{{ t('qrNotFound') }}</p>
          <div v-else data-testid="preview-qr-results" class="qr-results">
            <strong><QrCode :size="13" />{{ t('qrRecognized', { count: qrResults.length }) }}</strong>
            <article v-for="(result, index) in qrResults" :key="`${index}-${result}`" class="qr-result">
              <p>{{ result }}</p>
              <span class="recognized-text-actions">
                <button :data-testid="`copy-qr-result-${index}`" type="button" @click="emit('copyRecognizedText', result, t('qrCode'))"><Copy :size="12" />{{ t('qrCopy') }}</button>
                <button v-if="isSafeExternalUrl(result)" :data-testid="`open-qr-result-${index}`" type="button" @click="emit('openQrLink', result)"><ExternalLink :size="12" />{{ t('qrOpenLink') }}</button>
              </span>
            </article>
          </div>
        </section>
      </div>
      <CodePreview v-else-if="clip.kind === 'code'" class="preview-code" :code="clip.content" :language="codeLanguage" />
      <ul v-else-if="clip.kind === 'file'" data-testid="preview-file-list" class="preview-file-list">
        <li v-for="file in clip.files" :key="file.path" :data-file-exists="String(file.exists)" :class="{ 'is-missing': !file.exists }">
          <span class="preview-file-name">{{ file.name }}</span><span class="preview-file-status">{{ file.exists ? t('fileAvailable') : t('fileMissing') }}</span><span class="preview-file-path">{{ file.path }}</span>
        </li>
      </ul>
      <p v-else-if="clip.kind === 'link'" class="preview-link">{{ clip.content }}</p>
      <p v-else class="preview-copy">{{ clip.content }}</p>
    </div>
    <div class="preview-actions">
      <template v-if="defaultPasteMode(clip) === 'preserve'">
        <button ref="pasteButton" data-testid="preview-paste-preserve" class="primary-button" type="button" :disabled="pasteInFlight" @click="emit('paste', 'preserve')">{{ t('pastePreserve') }}</button>
        <button data-testid="preview-paste-plain" class="secondary-button" type="button" :disabled="pasteInFlight" @click="emit('paste', 'plain')">{{ t('pastePlain') }}</button>
      </template>
      <button v-else ref="pasteButton" data-testid="preview-paste" class="primary-button" type="button" :disabled="pasteInFlight || getClipActions(clip, 'quick')[0]?.disabled" @click="emit('paste')">{{ t('paste') }}</button>
    </div>
  </section>
</template>
