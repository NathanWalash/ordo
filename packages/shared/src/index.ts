import { z } from 'zod'

/** A top-level area of the app shown in the sidebar (Mail, Finance, ...). */
export interface ModuleInfo {
  id: string
  name: string
  /** Shown greyed out in the sidebar until the module exists. */
  comingSoon?: boolean
}

export const MODULES: readonly ModuleInfo[] = [
  { id: 'mail', name: 'Mail' },
  { id: 'finance', name: 'Finance', comingSoon: true },
]

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  accentColor: z.string().nullable(),
})
export type AppInfo = z.infer<typeof AppInfoSchema>

/**
 * The API the preload script exposes to the renderer as `window.ordo`.
 * Every method maps to one ipcMain.handle channel in the main process.
 */
export interface OrdoApi {
  app: {
    info(): Promise<AppInfo>
  }
}

export const IPC = {
  appInfo: 'app:info',
} as const
