import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { app } from 'electron'

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  | 'unsupported'

export interface UpdaterStatus {
  state: UpdaterState
  version?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  error?: string
}

type Listener = (status: UpdaterStatus) => void

const listeners = new Set<Listener>()
let status: UpdaterStatus = { state: 'idle' }
let configured = false
let activeSessionCheck: (() => Promise<boolean>) | undefined

function publish(next: UpdaterStatus): void {
  status = next
  for (const listener of listeners) listener(status)
}

function versionOf(info: UpdateInfo | undefined): string | undefined {
  return info?.version
}

function configure(): void {
  if (configured) return
  configured = true
  if (!app.isPackaged) {
    publish({ state: 'unsupported', error: 'Updates are available only in a packaged Reigen build' })
    return
  }

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'zachary-wilde',
    repo: 'reigen'
  })
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => publish({ state: 'available', version: versionOf(info) }))
  autoUpdater.on('update-not-available', (info) =>
    publish({ state: 'not-available', version: versionOf(info) })
  )
  autoUpdater.on('download-progress', (progress: ProgressInfo) =>
    publish({
      state: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    publish({ state: 'downloaded', version: versionOf(info) })
  )
  autoUpdater.on('error', (error) => publish({ state: 'error', error: error.message }))
}

export function initializeUpdater(isSessionActive?: () => Promise<boolean>): void {
  activeSessionCheck = isSessionActive
  configure()
}

export function getUpdaterStatus(): UpdaterStatus {
  configure()
  return status
}

export function subscribeUpdater(listener: Listener): () => void {
  configure()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function checkForUpdaterUpdates(): Promise<UpdaterStatus> {
  configure()
  if (!app.isPackaged) return status
  await autoUpdater.checkForUpdates()
  return status
}

export async function downloadUpdaterUpdate(): Promise<UpdaterStatus> {
  configure()
  if (!app.isPackaged) return status
  await autoUpdater.downloadUpdate()
  return status
}

export async function installUpdaterUpdate(confirmWithActiveSessions = false): Promise<UpdaterStatus> {
  configure()
  if (!app.isPackaged) return status
  if (!confirmWithActiveSessions && activeSessionCheck && (await activeSessionCheck())) {
    throw new Error('Active sessions must be confirmed before installing an update')
  }
  autoUpdater.quitAndInstall(false, true)
  return status
}
