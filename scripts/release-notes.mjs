// node scripts/release-notes.mjs <version>
// Prints the CHANGELOG.md section for a version, for the GitHub Release body. If there isn't one,
// prints a pointer to the changelog and warns (in GitHub Actions' format) rather than failing.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseNotes } from './lib/release.mjs'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const notes = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
if (notes) {
  process.stdout.write(`${notes}\n`)
} else {
  console.error(`::warning::CHANGELOG.md has no section for ${version}`)
  process.stdout.write(
    `See [CHANGELOG.md](https://github.com/NathanWalash/ordo/blob/v${version}/CHANGELOG.md) for what changed.\n`,
  )
}
// After the notes, so the in-app update notice (which shows the start) isn't about installing.
process.stdout.write(`
---

**Installing.** macOS: \`Ordo-${version}-mac-arm64.dmg\` for Apple silicon, \`Ordo-${version}-mac-x64.dmg\` for Intel.
Windows: \`Ordo-${version}-win-x64.exe\`. Builds aren't code-signed yet: on macOS right-click Ordo in
Applications and choose **Open** the first time (or, if macOS still refuses, **Open Anyway** in System
Settings → Privacy & Security); on Windows choose **More info**, then **Run anyway**.
`)
