import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

/**
 * Run the app as a hidden background app (no Dock icon, never focused) unless you want to watch:
 * `ORDO_E2E_SHOW=1 npx playwright test`. Test runs then don't steal focus from whatever you're doing.
 */
export const BACKGROUND_ENV: Record<string, string> =
  process.env['ORDO_E2E_SHOW'] === '1' ? {} : { ORDO_TEST_BACKGROUND: '1' }

/** Launch the built app with a fresh, throwaway profile. */
export function launchApp(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-'))
  return electron.launch({
    args: ['apps/desktop'],
    // Playwright emulates a light colour scheme by default; let the app's own theme setting decide.
    colorScheme: null,
    env: {
      ...(process.env as Record<string, string>),
      ORDO_USER_DATA: userData,
      // Linux runners have no keyring; let the unpackaged app use Electron's built-in key.
      ORDO_TEST_PLAINTEXT_SECRETS: '1',
      ...BACKGROUND_ENV,
      ...env,
    },
  })
}
