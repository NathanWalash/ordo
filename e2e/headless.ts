import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The Electron binary from node_modules (a path; requiring it downloads it on first use). */
export const electronPath = createRequire(import.meta.url)('electron') as string

/**
 * Playwright launches the windowed app with these Chromium switches, so a password saved there is
 * encrypted with Chromium's mock keychain key. Headless runs that reuse the profile need the same.
 */
export const KEYCHAIN_SWITCHES = ['--use-mock-keychain', '--password-store=basic']

/**
 * GitHub's Ubuntu runners block the unprivileged namespaces Chromium's sandbox needs, so Electron
 * aborts at start-up. Playwright adds --no-sandbox for the windowed tests; headless runs need it too.
 */
const PLATFORM_SWITCHES = process.platform === 'linux' ? ['--no-sandbox'] : []

/** Every Chromium switch a headless test run passes before the app path. */
export const TEST_SWITCHES = [...PLATFORM_SWITCHES, ...KEYCHAIN_SWITCHES]

export const tempProfile = () => mkdtempSync(join(tmpdir(), 'ordo-headless-'))

/** The environment a headless run gets: a throwaway profile and the same test overrides as the app. */
export function headlessEnv(userData: string, env: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ORDO_USER_DATA: userData,
    // Linux runners have no keyring; same opt-in as the windowed tests.
    ORDO_TEST_PLAINTEXT_SECRETS: '1',
    ...env,
  }
}

const normalise = (text: string) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '\n')
    .replace(/^\s*$/, '')

export interface Run {
  code: number | null
  stdout: string
  stderr: string
}

/** Run `Electron apps/desktop --headless <args>` like a user or script would, and collect its output. */
export function ordo(args: string[], userData: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [...TEST_SWITCHES, 'apps/desktop', '--headless', ...args], {
      env: headlessEnv(userData, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', reject)
    // Electron on Windows can add a blank line to stdout, before or after the output: compare
    // with \n line endings and no blank lines at either end, like a JSON or line reader would.
    child.on('close', (code) => resolve({ code, stdout: normalise(stdout), stderr }))
  })
}

/** Parse stdout as exactly one JSON document, failing loudly with the output if it isn't. */
export function json<T = Record<string, unknown>>(run: Run): T {
  try {
    return JSON.parse(run.stdout) as T
  } catch {
    throw new Error(
      `stdout is not one JSON document (exit ${run.code}):\n${run.stdout}\n--- stderr:\n${run.stderr}`,
    )
  }
}
