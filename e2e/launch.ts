import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

/** Launch the built app with a fresh, throwaway profile. */
export function launchApp(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-'))
  return electron.launch({
    args: ['apps/desktop'],
    env: {
      ...(process.env as Record<string, string>),
      ORDO_USER_DATA: userData,
      // Linux runners have no keyring; let the unpackaged app use Electron's built-in key.
      ORDO_TEST_PLAINTEXT_SECRETS: '1',
      ...env,
    },
  })
}
