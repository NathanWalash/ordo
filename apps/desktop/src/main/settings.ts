import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  SettingsSchema,
  ThemeSchema,
  type Settings,
  type SettingsPatch,
} from '@ordo/shared'

// Reading is forgiving: a bad field falls back to its default, a bad file to all defaults.
const StoredSettings = SettingsSchema.extend({
  theme: ThemeSchema.catch(DEFAULT_SETTINGS.theme),
}).catch(() => ({ ...DEFAULT_SETTINGS }))

/** Load settings from disk. Never throws: a missing, unreadable or corrupt file gives the defaults. */
export function readSettings(file: string): Settings {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  return StoredSettings.parse(raw)
}

/** Save settings, writing to a temp file first so a crash can't leave a half-written file. */
export function writeSettings(file: string, settings: Settings): void {
  const valid = SettingsSchema.parse(settings)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`)
  renameSync(tmp, file)
}

/** Validate a change from the renderer, merge it into what's saved and write it. Throws on a bad patch. */
export function updateSettings(file: string, patch: SettingsPatch): Settings {
  const next = { ...readSettings(file), ...SettingsPatchSchema.parse(patch) }
  writeSettings(file, next)
  return next
}
