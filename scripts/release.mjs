// pnpm release <version | patch | minor | major> [--dry-run] [--no-push]
//
// Cuts a release from a clean, up-to-date main: moves CHANGELOG.md's Unreleased entries under the
// new version, bumps apps/desktop/package.json, commits "chore(release): vX.Y.Z", tags vX.Y.Z and
// pushes main and the tag together. The tag starts .github/workflows/release.yml, which builds the
// installers into a draft GitHub Release for you to check and publish. See docs/updates.md.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cutRelease, nextVersion, releaseProblems, setPackageVersion } from './lib/release.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = join(root, 'CHANGELOG.md')
const PACKAGE = join(root, 'apps/desktop/package.json')

const args = process.argv.slice(2).filter((a) => a !== '--')
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const dryRun = flags.has('--dry-run')
const push = !flags.has('--no-push')

if (flags.has('--help') || positional.length !== 1) {
  console.log(`Usage: pnpm release <version | patch | minor | major> [--dry-run] [--no-push]

  --dry-run   Check and show what would change, without changing anything.
  --no-push   Commit and tag locally; push yourself with
              git push --atomic origin main v<version>`)
  process.exit(flags.has('--help') ? 0 : 1)
}
for (const f of flags)
  if (!['--dry-run', '--no-push'].includes(f)) {
    console.error(`Unknown option ${f}`)
    process.exit(1)
  }

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const step = (msg) => console.log(`\n→ ${msg}`)

try {
  step('Checking the checkout')
  git('fetch', '--quiet', '--tags', 'origin', 'main')
  const tagExists = (t) =>
    git('tag', '--list', t) !== '' || git('ls-remote', '--tags', 'origin', `refs/tags/${t}`) !== ''
  const current = JSON.parse(readFileSync(PACKAGE, 'utf8')).version
  // Before the first release the current version has no tag, so `pnpm release <current>` is allowed.
  const version = nextVersion(current, positional[0], { unreleased: !tagExists(`v${current}`) })
  const tag = `v${version}`
  const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD')
    .split(/\s+/)
    .map(Number)
  const problems = releaseProblems({
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
    behind,
    ahead,
    tag,
    tagExists: tagExists(tag),
  })
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`)
    process.exit(1)
  }
  console.log(
    `  ✓ Clean, on main, level with origin/main. Releasing ${version === current ? version : `${current} → ${version}`}.`,
  )

  const date = new Date().toISOString().slice(0, 10)
  const changelog = cutRelease(readFileSync(CHANGELOG, 'utf8'), version, date)
  const pkg = setPackageVersion(readFileSync(PACKAGE, 'utf8'), version)

  if (dryRun) {
    step('Dry run: nothing changed. This would:')
    console.log(`  • move CHANGELOG.md's Unreleased entries under "## [${version}] - ${date}"`)
    if (version !== current) console.log(`  • set apps/desktop/package.json version to ${version}`)
    console.log(`  • commit "chore(release): ${tag}" and tag ${tag}`)
    console.log(push ? `  • git push --atomic origin main ${tag}` : '  • not push (--no-push)')
    process.exit(0)
  }

  step('Updating CHANGELOG.md and apps/desktop/package.json')
  writeFileSync(CHANGELOG, changelog)
  writeFileSync(PACKAGE, pkg)

  step(`Committing and tagging ${tag}`)
  git('add', CHANGELOG, PACKAGE)
  git('commit', '--quiet', '-m', `chore(release): ${tag}`)
  git('tag', '--annotate', tag, '-m', `Ordo ${version}`)

  if (!push) {
    step(`Done locally. Push when ready:\n    git push --atomic origin main ${tag}`)
    process.exit(0)
  }

  step(`Pushing main and ${tag}`)
  try {
    execFileSync('git', ['push', '--atomic', 'origin', 'main', tag], { cwd: root, stdio: 'inherit' })
  } catch {
    console.error(`
The push was refused, so nothing reached GitHub (it's atomic). The release commit and tag are
still here. If main only accepts pull requests: push the commit on a branch, merge it, then
    git tag -f ${tag} <merged commit> && git push origin ${tag}
To undo locally instead: git tag -d ${tag} && git reset --hard HEAD~1`)
    process.exit(1)
  }
  step(
    `Pushed. The Release workflow is building ${tag}:\n    https://github.com/NathanWalash/ordo/actions/workflows/release.yml\n` +
      '  When it finishes, check the draft release, then publish it. Installed copies of Ordo only see published releases.',
  )
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
