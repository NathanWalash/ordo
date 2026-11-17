import { z } from 'zod'
import { AiSettingsSchema, DEFAULT_AI_SETTINGS } from './ai'

/** `system` follows the OS; `light` and `dark` override it for Ordo only. */
export const THEMES = ['system', 'light', 'dark'] as const
export const ThemeSchema = z.enum(THEMES)
export type Theme = z.infer<typeof ThemeSchema>

/** App preferences saved in `userData/settings.json`. */
export const SettingsSchema = z.object({
  theme: ThemeSchema,
  ai: AiSettingsSchema,
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = { theme: 'system', ai: DEFAULT_AI_SETTINGS }

/** What the renderer may change in one call. Unknown keys are rejected. */
export const SettingsPatchSchema = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/** How the window looks right now, beyond the theme the user picked. */
export interface Appearance {
  /** The window is currently dark (the theme setting, or the OS when it's `system`). */
  dark: boolean
  /** The OS asks for less transparency (macOS Reduce transparency, Windows Transparency effects off). */
  reducedTransparency: boolean
  /** No native material behind the sidebar (Windows 10, Linux): paint it solid. */
  opaqueSidebar: boolean
}

export interface SettingsApi {
  get(): Promise<Settings>
  /** Save a change and apply it; resolves with the full saved settings. */
  set(patch: SettingsPatch): Promise<Settings>
  appearance(): Promise<Appearance>
  /** Subscribe to appearance changes (theme or OS setting); returns an unsubscribe function. */
  onAppearance(listener: (a: Appearance) => void): () => void
}

export const SETTINGS_IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appearanceGet: 'appearance:get',
  appearanceChanged: 'appearance:changed',
} as const
