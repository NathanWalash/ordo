import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { SETTINGS_IPC, type Appearance, type SettingsPatch } from '@ordo/shared'
import { supportsMica } from './platform'
import { readSettings, updateSettings } from './settings'

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

/** Windows 11 has Mica behind the window; Windows 10 has no material, so the sidebar is painted solid. */
export const hasMica = () => supportsMica(process.platform, process.getSystemVersion())

export function currentAppearance(): Appearance {
  return {
    dark: nativeTheme.shouldUseDarkColors,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    opaqueSidebar: process.platform === 'linux' || (process.platform === 'win32' && !hasMica()),
  }
}

/**
 * Apply the saved theme and serve settings over IPC. Call once, before the first window opens.
 *
 * The theme goes through `nativeTheme.themeSource`, which drives the native material (vibrancy, Mica),
 * the title bar and `prefers-color-scheme` in the renderer, so the CSS needs no theme attribute.
 */
export function setupAppearance(): void {
  nativeTheme.themeSource = readSettings(settingsFile()).theme

  ipcMain.handle(SETTINGS_IPC.settingsGet, () => readSettings(settingsFile()))
  ipcMain.handle(SETTINGS_IPC.settingsSet, (_e, patch: SettingsPatch) => {
    const next = updateSettings(settingsFile(), patch)
    nativeTheme.themeSource = next.theme
    return next
  })
  ipcMain.handle(SETTINGS_IPC.appearanceGet, () => currentAppearance())

  // Fires when the theme, the OS appearance or the transparency preference changes.
  nativeTheme.on('updated', () => {
    const appearance = currentAppearance()
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send(SETTINGS_IPC.appearanceChanged, appearance)
  })
}
