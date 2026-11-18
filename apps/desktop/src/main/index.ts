import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, shell, systemPreferences } from 'electron'
import { IPC, type AppInfo, type ConnectInput } from '@ordo/shared'
import * as mail from './mail'
import { clearCalendar, closeCalendar, registerCalendarIpc } from './calendar'
import { registerCleanupIpc } from './cleanup'
import { hasMica, setupAppearance } from './appearance'
import { initAi, registerAiIpc, sendersWithAi } from './ai'
import { registerAssistantIpc, stop as stopAssistant } from './assistant'
import { closeMoney, registerMoneyIpc } from './money'
import { releaseWriteLock, toRenderer } from './writes'
import { headlessArgs } from './headless/args'
import { runHeadless } from './headless/run'

app.setName('Ordo')

// Tests run the unpackaged app against a throwaway profile.
const userData = !app.isPackaged ? process.env['ORDO_USER_DATA'] : undefined
if (userData) app.setPath('userData', userData)

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

function winOverlay() {
  return {
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000',
    height: 44,
  }
}

/**
 * In development Ordo runs inside the stock Electron app, which shows Electron's icon. Point the
 * Dock (macOS) and the window (Windows, Linux) at Ordo's own icon. Packaged builds get it from
 * electron-builder instead.
 */
const devIcon = (() => {
  if (app.isPackaged) return undefined
  const icon = join(__dirname, '../../build/icon.png')
  return existsSync(icon) ? icon : undefined
})()

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...(devIcon && !isMac && { icon: devIcon }),
    width: 1240,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: 'Ordo',
    // Transparent so the native material (macOS vibrancy / Windows Mica) shows through the sidebar.
    backgroundColor: '#00000000',
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }),
    ...(isWin && {
      titleBarStyle: 'hidden',
      titleBarOverlay: winOverlay(),
      backgroundMaterial: hasMica() ? 'mica' : 'none',
    }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Never let web content open windows or navigate the app away; send https links to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (isWin) nativeTheme.on('updated', () => win.setTitleBarOverlay(winOverlay()))

  // `--route=mail/unclutter` opens the app on a given screen (handy for screenshots and tests).
  const route = process.argv.find((a) => a.startsWith('--route='))?.slice('--route='.length) ?? 'home'
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}#/${route}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  return win
}

/** Start-up overrides for tests, honoured identically by the app and headless mode. */
function applyTestOverrides(): void {
  // Linux CI has no keyring; tests opt in to Electron's built-in key so the connect flow can run.
  if (!app.isPackaged && process.platform === 'linux' && process.env['ORDO_TEST_PLAINTEXT_SECRETS'] === '1')
    safeStorage.setUsePlainTextEncryption(true)
}

/** The app with its window: IPC handlers for the renderer, then the window once Electron is ready. */
function startApp(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    const accent = isMac || isWin ? systemPreferences.getAccentColor() : ''
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform as AppInfo['platform'],
      accentColor: accent ? `#${accent.slice(0, 6)}` : null,
    }
  })

  ipcMain.handle(IPC.accountStatus, () => mail.status())
  ipcMain.handle(IPC.accountTest, (_e, input: ConnectInput) => mail.test(input))
  ipcMain.handle(IPC.accountConnect, (_e, input: ConnectInput) => mail.connect(input))
  ipcMain.handle(IPC.accountDisconnect, () => mail.disconnect().then(clearCalendar))
  ipcMain.handle(IPC.scanStart, (e) => mail.scan(toRenderer(e.sender, IPC.scanProgress)))
  ipcMain.handle(IPC.scanStop, () => mail.stopScan())
  ipcMain.handle(IPC.sendersList, () => sendersWithAi())
  registerCalendarIpc()
  registerCleanupIpc()
  registerMoneyIpc()

  app.on('before-quit', () => mail.closeMail())
  app.on('before-quit', () => closeCalendar())
  app.on('before-quit', () => closeMoney())
  app.whenReady().then(() => {
    applyTestOverrides()
    // Only the windowed app: headless mode hides the Dock icon instead.
    if (devIcon && isMac) app.dock?.setIcon(devIcon)
    setupAppearance()
    initAi()
    registerAiIpc()
    registerAssistantIpc()
    app.on('before-quit', stopAssistant)
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}

// A write cut short by quitting must not leave the lock behind for the next run.
process.on('exit', releaseWriteLock)

// `--headless <command>` or `--headless --mcp`: no window, see headless/run.ts and docs/headless.md.
const headless = headlessArgs(process.argv)
if (headless) void runHeadless(headless, applyTestOverrides)
else startApp()
