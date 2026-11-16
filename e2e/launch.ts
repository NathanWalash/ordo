import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

/** Launch the built app with a fresh, throwaway profile. */
export function launchApp(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-'))
  return electron.launch({
    args: ['apps/desktop'],
    env: { ...process.env, ORDO_USER_DATA: userData, ...env } as Record<string, string>,
  })
}
