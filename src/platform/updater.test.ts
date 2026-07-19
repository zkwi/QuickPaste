import {
  checkForUpdate,
  connectUpdateCheckRequested,
  downloadUpdate,
  getCurrentVersion,
  installDownloadedUpdate,
  type UpdateChannelFactory,
  type UpdateInvoke,
  type UpdateListen,
} from './updater'

const availableUpdate = {
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  updateAvailable: true,
  prerelease: false,
  releaseName: 'QuickPaste 0.2.0',
  releaseNotes: '更快、更稳。',
  releaseUrl: 'https://github.com/zkwi/QuickPaste/releases/tag/v0.2.0',
  publishedAt: '2026-07-19T08:00:00Z',
  assetName: 'QuickPaste_0.2.0_x64-setup.exe',
  assetSize: 12_345_678,
  automaticInstallAvailable: true,
}

describe('Tauri updater bridge', () => {
  it('reads the packaged application version without duplicating it in the UI', async () => {
    const getVersion = vi.fn().mockResolvedValue('0.1.0')

    await expect(getCurrentVersion(getVersion)).resolves.toBe('0.1.0')
    expect(getVersion).toHaveBeenCalledOnce()
  })
  it('checks for updates and strictly maps the native response', async () => {
    const invoke: UpdateInvoke = vi.fn().mockResolvedValue(availableUpdate)

    await expect(checkForUpdate(invoke)).resolves.toEqual(availableUpdate)
    expect(invoke).toHaveBeenCalledWith('check_for_update', {})
  })

  it('rejects malformed update responses instead of leaking partial data into the UI', async () => {
    const invoke: UpdateInvoke = vi.fn().mockResolvedValue({
      ...availableUpdate,
      automaticInstallAvailable: 'yes',
    })

    await expect(checkForUpdate(invoke)).rejects.toThrow('更新服务返回的数据格式无效')
  })

  it('preserves a readable native error for a manual update check', async () => {
    const invoke: UpdateInvoke = vi.fn().mockRejectedValue('GitHub 更新服务暂时不可用。')

    await expect(checkForUpdate(invoke)).rejects.toThrow('GitHub 更新服务暂时不可用。')
  })

  it('safely degrades outside Tauri', async () => {
    await expect(checkForUpdate()).resolves.toBeNull()
    await expect(downloadUpdate('0.2.0', vi.fn())).resolves.toBeNull()
    await expect(installDownloadedUpdate('prepared-token')).resolves.toBeNull()
    await expect(connectUpdateCheckRequested(vi.fn())).resolves.toEqual(expect.any(Function))
  })

  it('downloads through a Tauri channel and forwards validated progress', async () => {
    const progressHandler = vi.fn()
    const channel = { onmessage: (_payload: unknown) => undefined }
    const createChannel: UpdateChannelFactory = vi.fn((onMessage) => {
      channel.onmessage = onMessage
      return channel
    })
    const invoke: UpdateInvoke = vi.fn(async (command, args) => {
      expect(command).toBe('download_update')
      expect(args).toEqual({ version: '0.2.0', onProgress: channel })
      channel.onmessage({
        phase: 'downloading',
        downloadedBytes: 5_000,
        totalBytes: 10_000,
        percent: 50,
      })
      channel.onmessage({
        phase: 'downloading',
        downloadedBytes: -1,
        totalBytes: 10_000,
        percent: 50,
      })
      return {
        token: 'prepared-token',
        version: '0.2.0',
        assetName: 'QuickPaste_0.2.0_x64-setup.exe',
      }
    })

    await expect(
      downloadUpdate('0.2.0', progressHandler, invoke, createChannel),
    ).resolves.toEqual({
      token: 'prepared-token',
      version: '0.2.0',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
    })
    expect(createChannel).toHaveBeenCalledOnce()
    expect(progressHandler).toHaveBeenCalledOnce()
    expect(progressHandler).toHaveBeenCalledWith({
      phase: 'downloading',
      downloadedBytes: 5_000,
      totalBytes: 10_000,
      percent: 50,
    })
  })

  it('rejects malformed download results and keeps download errors readable', async () => {
    const createChannel: UpdateChannelFactory = (onMessage) => ({ onmessage: onMessage })
    const malformedInvoke: UpdateInvoke = vi.fn().mockResolvedValue({
      token: null,
      version: '0.2.0',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
    })

    await expect(
      downloadUpdate('0.2.0', vi.fn(), malformedInvoke, createChannel),
    ).rejects.toThrow('更新下载服务返回的数据格式无效')

    const failedInvoke: UpdateInvoke = vi.fn().mockRejectedValue(new Error('下载连接中断。'))
    await expect(
      downloadUpdate('0.2.0', vi.fn(), failedInvoke, createChannel),
    ).rejects.toThrow('下载连接中断。')
  })

  it('starts only the prepared installer token and validates the native result', async () => {
    const invoke: UpdateInvoke = vi.fn().mockResolvedValue({
      version: '0.2.0',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
    })

    await expect(installDownloadedUpdate(' prepared-token ', invoke)).resolves.toEqual({
      version: '0.2.0',
      assetName: 'QuickPaste_0.2.0_x64-setup.exe',
    })
    expect(invoke).toHaveBeenCalledWith('install_downloaded_update', {
      token: 'prepared-token',
    })

    const malformedInvoke: UpdateInvoke = vi.fn().mockResolvedValue({ version: '0.2.0' })
    await expect(installDownloadedUpdate('prepared-token', malformedInvoke)).rejects.toThrow(
      '更新安装服务返回的数据格式无效',
    )
  })

  it('subscribes to native update-check requests and returns the cleanup callback', async () => {
    const cleanup = vi.fn()
    const onRequested = vi.fn()
    const listen: UpdateListen = async (eventName, callback) => {
      expect(eventName).toBe('update://check-requested')
      callback({})
      return cleanup
    }

    const disconnect = await connectUpdateCheckRequested(onRequested, listen)

    expect(onRequested).toHaveBeenCalledOnce()
    expect(disconnect).not.toBeNull()
    disconnect?.()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('reports an update event subscription failure as null', async () => {
    const listen: UpdateListen = vi.fn().mockRejectedValue(new Error('event bus unavailable'))

    await expect(connectUpdateCheckRequested(vi.fn(), listen)).resolves.toBeNull()
  })
})
