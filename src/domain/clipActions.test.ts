import { getClipActions, defaultPasteMode } from './clipActions'
import { createClipboardItem, type ClipboardItem } from './clipboard'

const textClip: ClipboardItem = {
  id: 'text', kind: 'text', title: 'Text', content: 'plain text', sourceApp: 'Notepad',
  copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [], formats: ['text'],
}
const richClip: ClipboardItem = {
  ...textClip, id: 'rich', formats: ['text', 'html', 'rtf'], html: '<strong>plain text</strong>',
  rtfBase64: 'e1xydGYxXGFuc2k=',
}
const fileClip: ClipboardItem = {
  ...textClip,
  id: 'files',
  kind: 'file',
  formats: ['files'],
  files: [{ path: 'C:\\Fixtures\\report.txt', name: 'report.txt', extension: '.txt', directory: false, exists: true }],
}
const imageClip: ClipboardItem = {
  ...textClip,
  id: 'image',
  kind: 'image',
  content: 'Screenshot',
  formats: ['image'],
  imageUrl: 'data:image/png;base64,AA==',
}
const linkClip: ClipboardItem = {
  ...textClip,
  id: 'link',
  kind: 'link',
  content: 'https://example.com/docs',
}

describe('clip action policy', () => {
  it('offers plain-text paste for rich clips in the quick surface', () => {
    expect(getClipActions(richClip, 'quick').map(({ id }) => id)).toContain('paste-plain')
  })

  it('offers manager-only file reveal while keeping file paste as the default mode', () => {
    expect(getClipActions(fileClip, 'manager').map(({ id }) => id)).toEqual([
      'paste', 'copy', 'open-file', 'reveal-file',
    ])
    expect(getClipActions(fileClip, 'quick').map(({ id }) => id)).not.toContain('reveal-file')
    expect(defaultPasteMode(fileClip)).toBe('files')
  })

  it('limits the quick surface to paste actions for every clip type', () => {
    for (const clip of [textClip, richClip, fileClip, imageClip, linkClip]) {
      expect(getClipActions(clip, 'quick').every(({ id }) => id.startsWith('paste'))).toBe(true)
    }
    expect(getClipActions(linkClip, 'quick').map(({ id }) => id)).not.toContain('open-link')
  })

  it('offers the manager type-action matrix without leaking link opening to quick', () => {
    expect(getClipActions(textClip, 'manager').map(({ id }) => id)).toEqual(['paste', 'copy'])
    expect(getClipActions(richClip, 'manager').map(({ id }) => id)).toEqual([
      'paste-preserve', 'paste-plain', 'copy',
    ])
    expect(getClipActions(imageClip, 'manager').map(({ id }) => id)).toEqual([
      'paste', 'copy', 'save-image',
    ])
    expect(getClipActions(linkClip, 'manager').map(({ id }) => id)).toEqual([
      'paste', 'copy', 'open-link',
    ])
  })

  it('visibly disables system actions when their typed payload is unavailable', () => {
    const missingFile = {
      ...fileClip,
      files: fileClip.files?.map((file) => ({ ...file, exists: false })),
    }
    const invalidLink = { ...linkClip, content: 'javascript:alert(1)' }
    const credentialLink = { ...linkClip, content: 'https://user:secret@example.com/private' }
    const paddedLink = { ...linkClip, content: ' https://example.com/private' }
    const controlledLink = { ...linkClip, content: 'https://example.com/\nprivate' }
    const oversizedLink = { ...linkClip, content: `https://example.com/${'a'.repeat(8 * 1024)}` }
    const missingImage = { ...imageClip, imageUrl: undefined }

    expect(getClipActions(missingFile, 'manager').find(({ id }) => id === 'open-file')?.disabled).toBe(true)
    expect(getClipActions(missingFile, 'manager').find(({ id }) => id === 'reveal-file')?.disabled).toBe(true)
    expect(getClipActions(invalidLink, 'manager').find(({ id }) => id === 'open-link')?.disabled).toBe(true)
    expect(getClipActions(credentialLink, 'manager').find(({ id }) => id === 'open-link')?.disabled).toBe(true)
    expect(getClipActions(paddedLink, 'manager').find(({ id }) => id === 'open-link')?.disabled).toBe(true)
    expect(getClipActions(controlledLink, 'manager').find(({ id }) => id === 'open-link')?.disabled).toBe(true)
    expect(getClipActions(oversizedLink, 'manager').find(({ id }) => id === 'open-link')?.disabled).toBe(true)
    expect(getClipActions(missingImage, 'manager').find(({ id }) => id === 'save-image')?.disabled).toBe(true)
  })

  it('keeps hydration-backed image and link actions available for native summaries', () => {
    const imageSummary: ClipboardItem = {
      id: 'image-summary', kind: 'image', title: 'Image', content: 'image preview', sourceApp: 'Snip',
      copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [], formats: ['image'],
      payloadLoaded: false,
    }
    const linkSummary: ClipboardItem = {
      id: 'link-summary', kind: 'link', title: 'Link', content: 'https://example.com/' + 'a'.repeat(600),
      sourceApp: 'Edge', copiedAt: '2026-07-19T02:00:00.000Z', pinned: false, searchTerms: [],
      formats: ['text'], payloadLoaded: false,
    }

    expect(getClipActions(imageSummary, 'quick')[0]?.disabled).not.toBe(true)
    expect(getClipActions(imageSummary, 'manager').find(({ id }) => id === 'save-image')?.disabled).not.toBe(true)
    expect(getClipActions(linkSummary, 'manager').find(({ id }) => id === 'open-link')?.disabled).not.toBe(true)
  })

  it('keeps exact paste disabled but allows opening existing paths from a partially missing file group', () => {
    const partiallyMissing = {
      ...fileClip,
      files: [
        ...fileClip.files!,
        { path: 'C:\\Fixtures\\missing.txt', name: 'missing.txt', directory: false, exists: false },
      ],
    }

    expect(getClipActions(partiallyMissing, 'quick')[0]?.disabled).toBe(true)
    const partialActions = getClipActions(partiallyMissing, 'manager')
    expect(partialActions.find(({ id }) => id === 'paste')?.disabled).toBe(true)
    expect(partialActions.find(({ id }) => id === 'open-file')?.disabled).not.toBe(true)
    expect(partialActions.find(({ id }) => id === 'reveal-file')?.disabled).not.toBe(true)

    const allMissing = {
      ...fileClip,
      files: fileClip.files?.map((file) => ({ ...file, exists: false })),
    }
    expect(getClipActions(allMissing, 'manager').find(({ id }) => id === 'open-file')?.disabled).toBe(true)
    expect(getClipActions(allMissing, 'manager').find(({ id }) => id === 'reveal-file')?.disabled).toBe(true)
  })

  it('uses preserve only when a rich text format is available', () => {
    expect(defaultPasteMode(textClip)).toBe('plain')
    expect(defaultPasteMode(richClip)).toBe('preserve')
  })

  it('uses normalized creation formats when choosing file and rich default paste modes', () => {
    const createdFile = createClipboardItem({
      kind: 'file', content: '', capturedAt: '2026-07-19T04:00:00.000Z', formats: ['text'],
      files: [{ path: 'C:\\Fixtures\\report.txt', name: 'report.txt', directory: false, exists: true }],
    }, 'created-file')
    const createdRich = createClipboardItem({
      kind: 'text', content: 'plain', capturedAt: '2026-07-19T04:00:00.000Z', formats: ['text'],
      html: '<strong>plain</strong>',
    }, 'created-rich')

    expect(defaultPasteMode(createdFile)).toBe('files')
    expect(defaultPasteMode(createdRich)).toBe('preserve')
  })
})
