// Test helper: writes stand-in `claude` and `codex` executables that record how they were called
// and answer like the real CLIs. Behaviour is chosen with the FAKE_MODE environment variable.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CommandResolver } from './process'

const SCRIPT = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const name = path.basename(process.argv[1])
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE || 'ok'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (stdin += c))
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args, stdin, cwd: process.cwd() }))
  if (mode === 'hang') return setInterval(() => {}, 1000)
  if (name === 'claude') return claude()
  return codex()
})
function claude() {
  if (args[0] === 'auth') {
    process.stdout.write(JSON.stringify({ loggedIn: mode !== 'signed-out', authMethod: 'claude.ai' }))
    return
  }
  if (mode === 'crash') {
    process.stderr.write('Error: something broke\n')
    process.exit(2)
  }
  if (mode === 'not-json') return process.stdout.write('hello')
  const envelope = {
    type: 'result',
    subtype: 'success',
    is_error: mode === 'is-error',
    result: mode === 'is-error' ? 'Not logged in · Please run /login' : '{"word":"yes"}',
    session_id: 'x',
    total_cost_usd: 0.0007,
  }
  if (mode !== 'is-error' && args.includes('--json-schema')) envelope.structured_output = { word: 'yes' }
  process.stdout.write(JSON.stringify(envelope))
}
function codex() {
  if (args[0] === 'login') {
    if (mode === 'signed-out') {
      process.stderr.write('Not logged in\n')
      process.exit(1)
    }
    process.stderr.write('Logged in using ChatGPT\n')
    return
  }
  if (mode === 'crash') {
    process.stderr.write('Error: unexpected argument\n')
    process.exit(2)
  }
  const out = args[args.indexOf('-o') + 1]
  const schemaAt = args.indexOf('--output-schema')
  const schema = schemaAt >= 0 ? fs.readFileSync(args[schemaAt + 1], 'utf8') : null
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args, stdin, cwd: process.cwd(), schema }))
  fs.writeFileSync(out, '{"word":"no"}\n')
  process.stdout.write('{"word":"no"}\n')
}
`

export interface FakeCliDir {
  dir: string
  log: string
  resolver: CommandResolver
}

/** A folder holding fake `claude` and `codex`, and a resolver that only searches it (and node). */
export function makeFakeClis(): FakeCliDir {
  const dir = mkdtempSync(join(tmpdir(), 'ordo-fake-cli-'))
  for (const name of ['claude', 'codex']) {
    const file = join(dir, name)
    writeFileSync(file, `#!/usr/bin/env node\n${SCRIPT}`)
    chmodSync(file, 0o755)
  }
  const resolver = new CommandResolver({
    shell: null,
    pathEnv: `${dir}:${dirname(process.execPath)}`,
    fallbackDirs: [],
  })
  return { dir, log: join(dir, 'log.json'), resolver }
}
