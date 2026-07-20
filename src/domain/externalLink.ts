const MAX_EXTERNAL_URL_BYTES = 8 * 1024

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || codePoint >= 0x7f && codePoint <= 0x9f) return true
  }
  return false
}

export function isSafeExternalUrl(value: string): boolean {
  if (!value
    || value.trim() !== value
    || containsControlCharacter(value)
    || utf8ByteLength(value) > MAX_EXTERNAL_URL_BYTES) return false

  const separator = value.indexOf('://')
  if (separator <= 0) return false
  const scheme = value.slice(0, separator)
  const authority = value.slice(separator + 3)
  if (!/^https?$/i.test(scheme) || !authority || authority.startsWith('/')) return false

  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(url.hostname)
      && !url.username
      && !url.password
  } catch {
    return false
  }
}
