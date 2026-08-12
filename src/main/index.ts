import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron'
import { basename, join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { applyWindowAcrylic } from './acrylic'
import { applyWindowCorners } from './window-corners'
import { connectOrSpawnCore, type ConnectOrSpawnOptions } from './core-client'
import { syncAutostart, isBackgroundLaunch } from './autostart'
import { createCoreConnection, type CoreConnection, type CoreStatus } from './core-connection'
import { initializeUpdater, getUpdaterStatus, subscribeUpdater, checkForUpdaterUpdates, downloadUpdaterUpdate, installUpdaterUpdate } from './updater'
import type { Settings } from '@shared/types'

// Electron is now a THIN CLIENT of the standalone Conductor Core. It owns no
// orchestration state: every backend `ipcMain.handle` proxies to the Core over
// the control channel, and the Core's event pushes are rebroadcast to the
// renderer. Closing the window disconnects this client; it never stops the Core
// or reaps the Core's child processes — that is the whole point of the split.
// Only genuine UI-process concerns (window controls, native dialog, shell,
// acrylic) stay here.

let mainWindow: BrowserWindow | null = null
let coreConn: CoreConnection | null = null

// A local snapshot of settings so the synchronous native acrylic and autostart
// paths need no round-trip. Seeded at boot/reconnect from the Core and refreshed
// whenever the renderer saves settings (the only mutator of settings on this side).
let settings: Settings | null = null

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

/**
 * A translucent window must be created transparent; the renderer then decides
 * how opaque each surface is. Non-Windows keeps the opaque background.
 */
function windowIsTranslucent(): boolean {
  return process.platform === 'win32'
}

/** Push the persisted acrylic preference onto the live window. */
let lastAcrylicMode = 'not-applied'

function syncWindowAcrylic(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !settings) return
  lastAcrylicMode = applyWindowAcrylic(mainWindow, settings.acrylic, settings.acrylicIntensity)
  console.log(`[conductor] acrylic mode: ${lastAcrylicMode}`)
}

/**
 * Rounded corners, kept in step with the window's size and maximize state.
 *
 * Logged once per change like the acrylic mode, because the Win10 path clips the
 * window region and a silent failure there looks like "the corners just are not
 * round" with nothing to grep for.
 */
let lastCornerMode = 'not-applied'

function syncWindowCorners(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const mode = applyWindowCorners(mainWindow)
  if (mode === lastCornerMode) return
  lastCornerMode = mode
  console.log(`[conductor] window corners: ${mode}`)
}

/**
 * Windows 10 only: drop acrylic to classic blur while the window is being moved or
 * resized, and restore it when the gesture ends. See the long note in git history;
 * this is DWM's acrylic composition backlog inside the native move loop, not a JS drag.
 */
let acrylicSuspended = false

function suspendWindowAcrylic(): void {
  if (
    acrylicSuspended ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !settings?.acrylic ||
    lastAcrylicMode !== 'acrylic-blur-behind'
  ) {
    return
  }
  acrylicSuspended = applyWindowAcrylic(mainWindow, true, settings.acrylicIntensity, true) === 'blur-classic'
}

function restoreWindowAcrylic(): void {
  if (!acrylicSuspended) return
  acrylicSuspended = false
  syncWindowAcrylic()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Conductor',
    backgroundColor: windowIsTranslucent() ? '#00000000' : '#0a0a0b',
    // Windows composites framed windows opaquely, so genuine translucency needs
    // a frameless window; the renderer draws its own title bar.
    transparent: windowIsTranslucent(),
    frame: !windowIsTranslucent(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const wc = mainWindow.webContents
  wc.on('did-finish-load', () => console.log('[conductor] renderer loaded'))
  wc.on('did-fail-load', (_e, code, desc, url) => console.error('[conductor] did-fail-load', code, desc, url))
  wc.on('render-process-gone', (_e, details) => console.error('[conductor] render-process-gone', JSON.stringify(details)))
  wc.on('console-message', (_e, _level, message) => console.log(`[conductor:renderer] ${message}`))
  if (process.env.CONDUCTOR_DEVTOOLS === '1') {
    wc.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    console.log('[conductor:startup] ready-to-show')
    syncWindowAcrylic()
    syncWindowCorners()
  })

  // Win10 acrylic composites badly inside the native move/resize loop; drop to classic
  // blur for the gesture and restore on the single terminal event.
  mainWindow.on('will-move', suspendWindowAcrylic)
  mainWindow.on('will-resize', suspendWindowAcrylic)
  mainWindow.on('moved', restoreWindowAcrylic)
  mainWindow.on('resized', () => {
    restoreWindowAcrylic()
    // A window region is a fixed pixel shape, not a rule: without this the new
    // size is clipped to the old one.
    syncWindowCorners()
  })
  mainWindow.on('maximize', syncWindowCorners)
  mainWindow.on('unmaximize', syncWindowCorners)
  mainWindow.on('enter-full-screen', syncWindowCorners)
  mainWindow.on('leave-full-screen', syncWindowCorners)

  mainWindow.on('closed', () => {
    acrylicSuspended = false
    mainWindow = null
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Native toast when a worktree hook failed; the renderer already shows it inline. */
function notifyHookFailure(payload: unknown): void {
  const result = payload as { worktreePath?: string; ok?: boolean; stderr?: string } | undefined
  if (!result || result.ok !== false) return
  const where = result.worktreePath ? basename(result.worktreePath) : 'worktree'
  const tail = (result.stderr ?? '').split('\n').slice(-2).join(' ')
  new Notification({ title: 'Worktree hook failed', body: `${where}: ${tail}` }).show()
}

/** Pull settings when the Core connects, syncing native effects and autostart policy. */
async function seedSettings(): Promise<void> {
  if (!coreConn) return
  try {
    settings = await coreConn.call<Settings>('settings:get')
    await syncAutostart(settings.autostart === true)
    syncWindowAcrylic()
  } catch {
    /* Core not ready; re-seeded on the next 'connected' status. */
  }
}

/** Every backend `ipcMain` channel now served by the Core, proxied verbatim by name. */
const PROXIED_CHANNELS = [
  'insight:getCurrent', 'insight:dismiss',
  'repo:list', 'repo:add', 'repo:remove',
  'branch:list', 'branch:current',
  'worktree:list', 'worktree:create', 'worktree:remove',
  'merge:preview', 'merge:land', 'merge:deleteBranch',
  'harness:detect', 'harness:modelCatalogues',
  'session:create', 'session:list', 'session:write', 'session:resize', 'session:kill', 'session:snapshot',
  'settings:get', 'settings:loadError',
  'system:readFile', 'system:writeFile', 'fs:listDir',
  'operations:pairing',
  'ravel:create', 'ravel:list', 'ravel:get', 'ravel:log', 'ravel:children',
  'ravel:sendMessage', 'ravel:updateBriefAssignment', 'ravel:requestPlanChanges',
  'ravel:approvePlan', 'ravel:retryCompilation', 'ravel:resumeInterruptedBrief',
  'ravel:steerChild', 'ravel:claimBrief', 'ravel:askFromSeat', 'ravel:finishSeat',
  'ravel:pause', 'ravel:resume', 'ravel:delete',
  'roundtable:list', 'roundtable:get', 'roundtable:create', 'roundtable:start',
  'roundtable:pause', 'roundtable:note', 'roundtable:delete'
] as const

function registerIpc(conn: CoreConnection): void {
  // Backend surface: forward to the Core unchanged (the connection manager
  // (re)connects on demand and rejects clearly while the Core is unavailable).
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, (_e, ...args) => conn.call(channel, ...args))
  }

  // settings:save is proxied too, but this process owns native acrylic and
  // packaged sign-in autostart, so refresh both policies after saving.
  ipcMain.handle('settings:save', async (_e, patch: Partial<Settings>) => {
    const saved = await conn.call<Settings>('settings:save', patch)
    settings = saved
    await syncAutostart(saved.autostart === true)
    if (patch.acrylic !== undefined || patch.acrylicIntensity !== undefined) syncWindowAcrylic()
    return saved
  })

  ipcMain.handle('store:reset', () => conn.call('store:reset'))
  ipcMain.handle('store:export', async () => {
    const res = await dialog.showSaveDialog({
      title: 'Export Conductor store',
      defaultPath: 'conductor-store.json',
      filters: [{ name: 'JSON files', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    await conn.call('store:export', res.filePath)
    return res.filePath
  })
  ipcMain.handle('store:import', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Import Conductor store',
      properties: ['openFile'],
      filters: [{ name: 'JSON files', extensions: ['json'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return false
    await conn.call('store:import', res.filePaths[0])
    return true
  })

  // UI-process-only concerns stay local — never sent to the Core.
  ipcMain.handle('system:pickDirectory', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })
  ipcMain.handle('system:openPath', (_e, p: string) => shell.openPath(p))

  ipcMain.handle('window:acrylicMode', () => lastAcrylicMode)
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  // Connection status + operator-driven retry for the Core link.
  ipcMain.handle('core:status', () => conn.status())
  ipcMain.handle('core:reconnect', () => {
    conn.reconnect()
  })

  ipcMain.handle('updater:status', () => getUpdaterStatus())
  ipcMain.handle('updater:check', () => checkForUpdaterUpdates())
  ipcMain.handle('updater:download', () => downloadUpdaterUpdate())
  ipcMain.handle('updater:install', (_e, confirmWithActiveSessions = false) =>
    installUpdaterUpdate(confirmWithActiveSessions)
  )
  subscribeUpdater((next) => send('updater:status', next))
}

// Smoke isolation must happen before anything resolves a userData path; the base
// is forwarded to the spawned Core so it isolates its data dir the same way.
const smokeUserData = process.env.CONDUCTOR_SMOKE_USER_DATA
if (smokeUserData) {
  app.setPath('userData', smokeUserData)
  console.log(`[conductor] smoke userData: ${smokeUserData}`)
}

const dummyHarnessScript = process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS
if (dummyHarnessScript) {
  console.log(`[conductor] dummy harness active for every harness: ${dummyHarnessScript}`)
  if (!smokeUserData) {
    console.warn('[conductor] dummy harness without CONDUCTOR_SMOKE_USER_DATA — the real store is in use')
  }
}

/** Shared connect options for the Core link (normal window boot and --background). */
// CONDUCTOR_WEB_TLS is inherited by the detached Core; its default/override
// policy is resolved there together with CONDUCTOR_WEB_HOST.
function coreConnectOptions(): ConnectOrSpawnOptions {
  return {
    base: app.getPath('userData'),
    coreEntry: join(__dirname, 'core.js'),
    version: app.getVersion(),
    webStaticDir: join(__dirname, '../web'),
    webHost: process.env.CONDUCTOR_WEB_HOST,
    webToken: process.env.CONDUCTOR_WEB_TOKEN,
    webPort: process.env.CONDUCTOR_WEB_PORT ? Number(process.env.CONDUCTOR_WEB_PORT) : undefined
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.conductor.app')
  app.on('browser-window-created', (_e, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Sign-in autostart: Windows relaunched us with --background. Ensure the
  // detached Core is running (so scheduled work fires at sign-in), then exit
  // with no window. The Core outlives this process; a later normal launch
  // connects to it.
  if (isBackgroundLaunch(process.argv)) {
    try {
      const client = await connectOrSpawnCore(coreConnectOptions())
      client.close()
    } catch (error) {
      console.error('[conductor] background Core boot failed', error)
    }
    app.quit()
    return
  }

  // Autostart is user opt-in. seedSettings() reconciles it after every Core
  // connection, and settings:save reconciles it immediately after a change.

  // Build the resilient Core link: it retries/reconnects on its own and pushes
  // status to the renderer. IPC is registered UNCONDITIONALLY so the app is
  // never left inert without handlers if the Core is momentarily unreachable.
  coreConn = createCoreConnection({
    connect: () => connectOrSpawnCore(coreConnectOptions()),
    onStatus: (status: CoreStatus) => {
      send('core:status', status)
      if (status.state === 'connected') void seedSettings()
    },
    onEvent: (channel, args) => {
      send(channel, ...args)
      if (channel === 'hook:result') notifyHookFailure(args[0])
    }
  })
  registerIpc(coreConn)
  initializeUpdater(async () => {
    try {
      const sessions = await coreConn?.call<Array<{ status?: string }>>('session:list')
      return sessions?.some((session) => session.status === 'running') === true
    } catch {
      return false
    }
  })
  coreConn.start()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Closing every window ends this CLIENT. The Core keeps running (with its child
// sessions and timers) so work continues and a later launch reconnects.
app.on('window-all-closed', () => {
  coreConn?.close()
  coreConn = null
  if (process.platform !== 'darwin') app.quit()
})
