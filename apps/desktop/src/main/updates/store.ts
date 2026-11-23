// What the update check remembers, in its own small file (`userData/updates.json`).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { SkipVersionSchema } from '@ordo/shared'

const StoreSchema = z.object({
  checksEnabled: z.boolean(),
  lastCheckedAt: z.string().max(40).nullable(),
  skippedVersion: SkipVersionSchema.nullable(),
})
export type UpdateStore = z.infer<typeof StoreSchema>

export const DEFAULT_UPDATE_STORE: UpdateStore = {
  checksEnabled: true,
  lastCheckedAt: null,
  skippedVersion: null,
}

// Reading is forgiving, like settings.json: a bad field gets its default, a bad file all defaults.
const Stored = z
  .object({
    checksEnabled: StoreSchema.shape.checksEnabled.catch(DEFAULT_UPDATE_STORE.checksEnabled),
    lastCheckedAt: StoreSchema.shape.lastCheckedAt.catch(null),
    skippedVersion: StoreSchema.shape.skippedVersion.catch(null),
  })
  .catch(() => ({ ...DEFAULT_UPDATE_STORE }))

/** Never throws: a missing, unreadable or corrupt file gives the defaults. */
export function readUpdateStore(file: string): UpdateStore {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...DEFAULT_UPDATE_STORE }
  }
  return Stored.parse(raw)
}

/** Merge a change into what's saved, writing a temp file first so a crash can't leave half a file. */
export function updateUpdateStore(file: string, patch: Partial<UpdateStore>): UpdateStore {
  const next = StoreSchema.parse({ ...readUpdateStore(file), ...patch })
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, file)
  return next
}
