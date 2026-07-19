export type UpdateInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>

export type UpdateListen = (
  eventName: string,
  callback: (payload: unknown) => void,
) => Promise<() => void>

export type UpdateVersionProvider = () => Promise<string>

export interface UpdateProgressChannel {
  onmessage: (payload: unknown) => void
}

export type UpdateChannelFactory = (
  onMessage: (payload: unknown) => void,
) => UpdateProgressChannel | Promise<UpdateProgressChannel>

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  prerelease: boolean
  releaseName: string
  releaseNotes: string
  releaseUrl: string
  publishedAt: string | null
  assetName: string | null
  assetSize: number | null
  automaticInstallAvailable: boolean
}

export type UpdatePhase = 'downloading' | 'verifying' | 'installing'

export interface UpdateProgress {
  phase: UpdatePhase
  downloadedBytes: number
  totalBytes: number
  percent: number
}

export interface InstallUpdateResult {
  version: string
  assetName: string
}

export interface PreparedUpdateResult extends InstallUpdateResult {
  token: string
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invokeThroughTauri(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

async function createTauriChannel(
  onMessage: (payload: unknown) => void,
): Promise<UpdateProgressChannel> {
  const { Channel } = await import('@tauri-apps/api/core')
  return new Channel<unknown>(onMessage)
}

async function listenThroughTauri(
  eventName: string,
  callback: (payload: unknown) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<unknown>(eventName, (event) => callback(event.payload))
}

async function getVersionThroughTauri(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseUpdateStatus(value: unknown): UpdateStatus {
  if (
    !isRecord(value)
    || typeof value.currentVersion !== 'string'
    || typeof value.latestVersion !== 'string'
    || typeof value.updateAvailable !== 'boolean'
    || typeof value.prerelease !== 'boolean'
    || typeof value.releaseName !== 'string'
    || typeof value.releaseNotes !== 'string'
    || typeof value.releaseUrl !== 'string'
    || !isNullableString(value.publishedAt)
    || !isNullableString(value.assetName)
    || !(value.assetSize === null || isNonNegativeInteger(value.assetSize))
    || typeof value.automaticInstallAvailable !== 'boolean'
  ) {
    throw new Error('更新服务返回的数据格式无效。')
  }

  return {
    currentVersion: value.currentVersion,
    latestVersion: value.latestVersion,
    updateAvailable: value.updateAvailable,
    prerelease: value.prerelease,
    releaseName: value.releaseName,
    releaseNotes: value.releaseNotes,
    releaseUrl: value.releaseUrl,
    publishedAt: value.publishedAt,
    assetName: value.assetName,
    assetSize: value.assetSize,
    automaticInstallAvailable: value.automaticInstallAvailable,
  }
}

function parseUpdateProgress(value: unknown): UpdateProgress | null {
  if (
    !isRecord(value)
    || !(['downloading', 'verifying', 'installing'] as const).includes(
      value.phase as UpdatePhase,
    )
    || !isNonNegativeInteger(value.downloadedBytes)
    || !isNonNegativeInteger(value.totalBytes)
    || value.downloadedBytes > value.totalBytes
    || !isNonNegativeInteger(value.percent)
    || value.percent > 100
  ) {
    return null
  }

  return {
    phase: value.phase as UpdatePhase,
    downloadedBytes: value.downloadedBytes,
    totalBytes: value.totalBytes,
    percent: value.percent,
  }
}

function parseInstallResult(value: unknown): InstallUpdateResult {
  if (
    !isRecord(value)
    || typeof value.version !== 'string'
    || value.version.trim().length === 0
    || typeof value.assetName !== 'string'
    || value.assetName.trim().length === 0
  ) {
    throw new Error('更新安装服务返回的数据格式无效。')
  }

  return {
    version: value.version,
    assetName: value.assetName,
  }
}

function parsePreparedResult(value: unknown): PreparedUpdateResult {
  const result = parseInstallResult(value)
  if (
    !isRecord(value)
    || typeof value.token !== 'string'
    || value.token.trim().length === 0
  ) {
    throw new Error('更新下载服务返回的数据格式无效。')
  }

  return {
    token: value.token,
    ...result,
  }
}

function readableError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.trim().length > 0) return error
  if (typeof error === 'string' && error.trim().length > 0) return new Error(error)
  if (
    isRecord(error)
    && typeof error.message === 'string'
    && error.message.trim().length > 0
  ) {
    return new Error(error.message)
  }
  return new Error(fallback)
}

export async function checkForUpdate(
  invokeAdapter?: UpdateInvoke,
): Promise<UpdateStatus | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null

  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)('check_for_update', {})
    return parseUpdateStatus(result)
  } catch (error) {
    throw readableError(error, '检查更新失败，请稍后重试。')
  }
}

export async function getCurrentVersion(
  versionProvider?: UpdateVersionProvider,
): Promise<string | null> {
  if (!versionProvider && !isTauriRuntime()) return null

  try {
    const version = await (versionProvider ?? getVersionThroughTauri)()
    return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null
  } catch {
    return null
  }
}

export async function downloadUpdate(
  version: string,
  onProgress: (progress: UpdateProgress) => void,
  invokeAdapter?: UpdateInvoke,
  channelFactory?: UpdateChannelFactory,
): Promise<PreparedUpdateResult | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null

  const normalizedVersion = version.trim()
  if (normalizedVersion.length === 0) throw new Error('更新版本不能为空。')

  try {
    const channel = await (channelFactory ?? createTauriChannel)((payload) => {
      const progress = parseUpdateProgress(payload)
      if (progress) onProgress(progress)
    })
    const result = await (invokeAdapter ?? invokeThroughTauri)(
      'download_update',
      { version: normalizedVersion, onProgress: channel },
    )
    return parsePreparedResult(result)
  } catch (error) {
    throw readableError(error, '下载更新失败，请稍后重试。')
  }
}

export async function installDownloadedUpdate(
  token: string,
  invokeAdapter?: UpdateInvoke,
): Promise<InstallUpdateResult | null> {
  if (!invokeAdapter && !isTauriRuntime()) return null

  const normalizedToken = token.trim()
  if (normalizedToken.length === 0) throw new Error('已下载的更新标识不能为空。')

  try {
    const result = await (invokeAdapter ?? invokeThroughTauri)(
      'install_downloaded_update',
      { token: normalizedToken },
    )
    return parseInstallResult(result)
  } catch (error) {
    throw readableError(error, '启动更新安装程序失败，请稍后重试。')
  }
}

export async function connectUpdateCheckRequested(
  onRequested: () => void,
  listenAdapter?: UpdateListen,
): Promise<(() => void) | null> {
  if (!listenAdapter && !isTauriRuntime()) return () => undefined

  try {
    return await (listenAdapter ?? listenThroughTauri)(
      'update://check-requested',
      () => onRequested(),
    )
  } catch {
    return null
  }
}
