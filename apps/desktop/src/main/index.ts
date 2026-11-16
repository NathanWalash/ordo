import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, shell, systemPreferences } from 'electron'
import { IPC, type AppInfo } from '@ordo/shared'

app.setName('Ordo')

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

function winOverlay() {
  return {
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000',
    height: 44,
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
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
      backgroundMaterial: 'mica',
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

ipcMain.handle(IPC.appInfo, (): AppInfo => {
  const accent = isMac || isWin ? systemPreferences.getAccentColor() : ''
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform as AppInfo['platform'],
    accentColor: accent ? `#${accent.slice(0, 6)}` : null,
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
