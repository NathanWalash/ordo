// On macOS, the menu bar, Dock and Cmd-Tab name an app after its bundle, and in development
// that bundle is node_modules/electron's Electron.app, so Ordo shows up as "Electron".
// app.setName() can't change it at runtime. Rename the development bundle to Ordo instead.
// Packaged builds are named by electron-builder and don't need this. Runs before `pnpm dev`.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const NAME = 'Ordo'

if (process.platform === 'darwin') {
  try {
    // The electron package exports the path of its executable: Electron.app/Contents/MacOS/Electron.
    const exe = createRequire(import.meta.url)('electron')
    const plist = join(dirname(dirname(exe)), 'Info.plist')
    if (existsSync(plist)) {
      const read = (key) => {
        try {
          return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
        } catch {
          return null
        }
      }
      for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
        if (read(key) === NAME) continue
        const op = read(key) === null ? '-insert' : '-replace'
        execFileSync('plutil', [op, key, '-string', NAME, plist])
      }
    }
  } catch (err) {
    // Only cosmetic: never stop `pnpm dev` over it.
    console.warn(`Couldn't name the development app ${NAME}: ${err instanceof Error ? err.message : err}`)
  }
}
