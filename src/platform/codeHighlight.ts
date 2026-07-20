import type { CodePreviewLanguage } from '../domain/codeLanguage'

export const MAX_HIGHLIGHT_CODE_UNITS = 200_000

interface HighlighterCore {
  registerLanguage: (name: string, definition: LanguageDefinition) => void
  highlight: (
    code: string,
    options: { language: string; ignoreIllegals: true },
  ) => { value: string }
}

type LanguageDefinition = (highlighter: unknown) => unknown
type DynamicModuleLoader = () => Promise<{ default: unknown }>

export interface CodeHighlightRuntime {
  highlight: (
    code: string,
    language: CodePreviewLanguage,
    isCurrent?: () => boolean,
  ) => Promise<string | null>
}

interface CodeHighlightDependencies {
  loadCore?: DynamicModuleLoader
  languageLoaders?: Readonly<Partial<Record<CodePreviewLanguage, DynamicModuleLoader>>>
}

const loadDefaultCore: DynamicModuleLoader = () => import('highlight.js/lib/core')

// 字面量 loader 是构建边界：新增语言必须同时更新产品白名单和 manifest 门槛。
const DEFAULT_LANGUAGE_LOADERS: Readonly<Record<CodePreviewLanguage, DynamicModuleLoader>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  python: () => import('highlight.js/lib/languages/python'),
  rust: () => import('highlight.js/lib/languages/rust'),
  sql: () => import('highlight.js/lib/languages/sql'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  bash: () => import('highlight.js/lib/languages/bash'),
}

export function createCodeHighlightRuntime(
  dependencies: CodeHighlightDependencies = {},
): CodeHighlightRuntime {
  const loadCore = dependencies.loadCore ?? loadDefaultCore
  const languageLoaders = dependencies.languageLoaders ?? DEFAULT_LANGUAGE_LOADERS
  const registrations = new Map<CodePreviewLanguage, Promise<HighlighterCore>>()
  let corePromise: Promise<HighlighterCore> | undefined

  const getCore = (): Promise<HighlighterCore> => {
    if (corePromise) return corePromise
    const pending = loadCore().then((module) => module.default as HighlighterCore)
    corePromise = pending
    void pending.catch(() => {
      if (corePromise === pending) corePromise = undefined
    })
    return pending
  }

  const getRegisteredCore = (language: CodePreviewLanguage): Promise<HighlighterCore> => {
    const existing = registrations.get(language)
    if (existing) return existing
    const loadLanguage = languageLoaders[language]
    if (!loadLanguage) return Promise.reject(new Error('unsupported code language'))

    const pending = Promise.all([getCore(), loadLanguage()]).then(([core, module]) => {
      core.registerLanguage(language, module.default as LanguageDefinition)
      return core
    })
    registrations.set(language, pending)
    void pending.catch(() => {
      if (registrations.get(language) === pending) registrations.delete(language)
    })
    return pending
  }

  return {
    async highlight(code, language, isCurrent = () => true) {
      if (typeof code !== 'string'
        || code.length > MAX_HIGHLIGHT_CODE_UNITS
        || !Object.hasOwn(languageLoaders, language)
        || !isCurrent()) return null
      try {
        const core = await getRegisteredCore(language)
        if (!isCurrent()) return null
        const result = core.highlight(code, { language, ignoreIllegals: true })
        return typeof result.value === 'string' ? result.value : null
      } catch {
        return null
      }
    },
  }
}

const defaultRuntime = createCodeHighlightRuntime()

export function highlightCode(
  code: string,
  language: CodePreviewLanguage,
  isCurrent?: () => boolean,
): Promise<string | null> {
  return defaultRuntime.highlight(code, language, isCurrent)
}
