import { describe, expect, it } from 'vitest'
import { CHANGE_COMMANDS, commandFrom, headlessArgs, parseInvocation, UsageError } from './args'

const command = (...args: string[]) => {
  const inv = parseInvocation(args)
  if (inv.kind !== 'command') throw new Error(`expected a command, got ${inv.kind}`)
  return inv
}
const usage = (...args: string[]) => {
  try {
    parseInvocation(args)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return (err as Error).message
  }
  throw new Error('expected a usage error')
}

describe('headlessArgs', () => {
  it('finds the arguments after --headless, wherever Electron put them', () => {
    expect(headlessArgs(['/x/Electron', 'apps/desktop', '--headless', 'status', '--json'])).toEqual([
      'status',
      '--json',
    ])
    expect(headlessArgs(['/Applications/Ordo.app/Contents/MacOS/Ordo', '--headless'])).toEqual([])
    expect(headlessArgs(['/x/Electron', 'apps/desktop'])).toBeNull()
  })

  it('drops the -- that `pnpm ordo -- status` passes through', () => {
    expect(headlessArgs(['e', 'apps/desktop', '--headless', '--', 'status'])).toEqual(['status'])
  })
})

describe('parseInvocation', () => {
  it('reads global flags anywhere', () => {
    expect(command('--json', 'status')).toEqual({
      kind: 'command',
      command: { name: 'status' },
      json: true,
      allowChanges: false,
    })
    expect(command('status', '--allow-changes').allowChanges).toBe(true)
  })

  it('gives help for nothing, help, --help and -h', () => {
    expect(parseInvocation([])).toEqual({ kind: 'help', json: false })
    expect(parseInvocation(['help', 'cleanup'])).toEqual({ kind: 'help', json: false, topic: 'cleanup' })
    expect(parseInvocation(['senders', '--help'])).toMatchObject({ kind: 'help' })
    expect(parseInvocation(['-h', '--json'])).toEqual({ kind: 'help', json: true })
  })

  it('parses the MCP server mode, which takes only --allow-changes', () => {
    expect(parseInvocation(['--mcp'])).toEqual({ kind: 'mcp', allowChanges: false })
    expect(parseInvocation(['--mcp', '--allow-changes'])).toEqual({ kind: 'mcp', allowChanges: true })
    expect(usage('--mcp', 'status')).toMatch(/--mcp/)
    expect(usage('--mcp', '--json')).toMatch(/--mcp/)
  })

  it('applies defaults and coerces numbers', () => {
    expect(command('senders').command).toEqual({ name: 'senders', limit: 50 })
    expect(command('senders', '--limit', '5', '--category', 'Other').command).toEqual({
      name: 'senders',
      limit: 5,
      category: 'uncategorised',
    })
    expect(command('senders', '--limit=7').command).toMatchObject({ limit: 7 })
    expect(command('history').command).toEqual({ name: 'history', limit: 10 })
  })

  it('collects repeated --sender and the cleanup switches', () => {
    expect(
      command('cleanup', 'plan', '--sender', 'a@x.example', '--sender=b@y.example', '--no-trash').command,
    ).toEqual({
      name: 'cleanup plan',
      sender: ['a@x.example', 'b@y.example'],
      'no-unsubscribe': false,
      'no-trash': true,
    })
    expect(command('cleanup', 'run', '--sender', 'a@x.example', '--confirm').command).toMatchObject({
      name: 'cleanup run',
      confirm: true,
    })
  })

  it('takes positional arguments where a command has them', () => {
    expect(command('undo', '12', '--confirm').command).toEqual({ name: 'undo', id: 12, confirm: true })
    expect(command('money', 'import', 'statement.csv', '--account', 'Joint').command).toEqual({
      name: 'money import',
      file: 'statement.csv',
      account: 'Joint',
      confirm: false,
    })
  })

  it('parses the read-only mail commands', () => {
    expect(command('mail', 'list').command).toEqual({
      name: 'mail list',
      mailbox: 'INBOX',
      unread: false,
      limit: 25,
    })
    expect(command('mail', 'list', '--mailbox', 'Sent Messages', '--unread').command).toMatchObject({
      mailbox: 'Sent Messages',
      unread: true,
    })
    expect(command('mail', 'search', 'gas bill', '--server').command).toEqual({
      name: 'mail search',
      query: 'gas bill',
      server: true,
      limit: 25,
    })
    expect(command('mail', 'read', '42', '--mailbox', 'Archive').command).toEqual({
      name: 'mail read',
      uid: 42,
      mailbox: 'Archive',
    })
    expect(command('mail', 'sync').command).toEqual({ name: 'mail sync', mailbox: 'INBOX' })
    expect(() => parseInvocation(['mail', 'read'])).toThrow(/needs a message uid/)
    expect(() => parseInvocation(['mail', 'read', 'x'])).toThrow(UsageError)
    expect(() => parseInvocation(['mail', 'search'])).toThrow(/something to look for/)
    expect(() => parseInvocation(['mail', 'send'])).toThrow(/Unknown command: mail send/)
    expect(() => parseInvocation(['mail', 'list', '--mailbox', 'a\u0007b'])).toThrow(/not a mailbox path/)
  })

  it('parses the mail changes: several uids, a target, and no send', () => {
    expect(command('mail', 'move', '41', '42', '--to', 'archive', '--confirm').command).toEqual({
      name: 'mail move',
      uids: [41, 42],
      mailbox: 'INBOX',
      to: 'archive',
      confirm: true,
    })
    expect(
      command('mail', 'move', '41', '--mailbox', 'Archive', '--to', 'Projects/2026').command,
    ).toMatchObject({
      mailbox: 'Archive',
      to: 'Projects/2026',
      confirm: false,
    })
    expect(command('mail', 'flag', '7', '--unflag').command).toEqual({
      name: 'mail flag',
      uids: [7],
      mailbox: 'INBOX',
      unflag: true,
      confirm: false,
    })
    expect(command('mail', 'mark', '7', '8', '--unread').command).toMatchObject({
      uids: [7, 8],
      read: false,
      unread: true,
    })
    expect(command('mail', 'undo').command).toEqual({ name: 'mail undo', confirm: false })
    expect(command('mail', 'undo', '3', '--confirm').command).toEqual({
      name: 'mail undo',
      id: 3,
      confirm: true,
    })
    expect(usage('mail', 'move', '--to', 'archive')).toMatch(/needs at least one message uid/)
    expect(usage('mail', 'move', '41')).toMatch(/needs --to archive, bin, junk, inbox or a folder/)
    expect(usage('mail', 'move', '1e3', '--to', 'archive')).toMatch(/whole number/)
    expect(usage('mail', 'move', '4', '4', '--to', 'archive')).toMatch(/given twice/)
    expect(
      usage('mail', 'move', ...Array.from({ length: 21 }, (_, i) => String(i + 1)), '--to', 'bin'),
    ).toMatch(/At most 20 messages/)
    expect(usage('mail', 'mark', '7')).toMatch(/--read or --unread/)
    expect(usage('mail', 'mark', '7', '--read', '--unread')).toMatch(/--read or --unread/)
    expect(usage('mail', 'move', '7', '--uids', '8', '--to', 'bin')).toMatch(/Unknown option --uids/)
    expect(usage('mail', 'move', '7', '--to', 'a\u0007b')).toMatch(/not a folder/)
    for (const c of ['send', 'reply', 'forward', 'draft']) expect(usage('mail', c)).toMatch(/Unknown command/)
  })

  it('checks dates and ranges for calendar events', () => {
    expect(command('calendar', 'events', '--from', '2026-11-01', '--to', '2026-11-30').command).toEqual({
      name: 'calendar events',
      from: '2026-11-01',
      to: '2026-11-30',
      limit: 100,
    })
    expect(usage('calendar', 'events', '--from', '2026-11-01')).toMatch(/--to is required/)
    expect(usage('calendar', 'events', '--from', '2026-02-30', '--to', '2026-03-01')).toMatch(/real date/)
    expect(usage('calendar', 'events', '--from', '2026-11-30', '--to', '2026-11-01')).toMatch(/after --from/)
    expect(usage('calendar', 'events', '--from', '2026-01-01', '--to', '2027-06-01')).toMatch(/400 days/)
  })

  it('refuses unknown commands, flags and stray arguments', () => {
    expect(usage('frobnicate')).toBe('Unknown command: frobnicate. See `help`.')
    expect(usage('cleanup')).toMatch(/needs a subcommand/)
    expect(usage('cleanup', 'nuke')).toMatch(/Unknown command: cleanup nuke/)
    expect(usage('status', '--verbose')).toBe('Unknown option --verbose')
    expect(usage('status', '-v')).toBe('Unknown option -v')
    expect(usage('status', '--limit', '3')).toBe("status doesn't take --limit")
    expect(usage('status', 'extra')).toBe('Unexpected argument: extra')
    expect(usage('scan', '--confirm')).toBe("scan doesn't take --confirm")
    expect(usage('undo', '3', '4')).toBe('Unexpected argument: 4')
  })

  it('refuses malformed values', () => {
    expect(usage('senders', '--limit')).toBe('--limit needs a value')
    expect(usage('senders', '--limit', 'ten')).toBe('--limit must be a number')
    expect(usage('senders', '--limit', '0')).toBe('--limit must be at least 1')
    expect(usage('senders', '--limit', '1', '--limit', '2')).toBe('--limit is given twice')
    expect(usage('senders', '--category', 'spam')).toMatch(/--category must be one of/)
    expect(usage('senders', '--json=yes')).toBe("--json doesn't take a value")
    expect(usage('cleanup', 'plan')).toBe('Name at least one --sender <address>')
    expect(usage('undo')).toMatch(/clean-up id/)
    expect(usage('undo', 'abc')).toMatch(/clean-up id/)
    expect(usage('money', 'transactions', '--month', '2026-13')).toMatch(/--month/)
    expect(usage('money', 'import')).toMatch(/\.csv file/)
  })
})

describe('stricter parsing', () => {
  it('reads numbers only as plain digits, so a mistyped undo id reaches nothing', () => {
    expect(usage('undo', '1e3', '--confirm')).toMatch(/clean-up id/)
    expect(usage('senders', '--limit', '0x10')).toBe('--limit must be a number')
    expect(usage('senders', '--limit', '2.5')).toBe('--limit must be a number')
    expect(command('undo', '12', '--confirm')).toMatchObject({ command: { id: 12 } })
    expect(command('senders', '--limit', '5')).toMatchObject({ command: { limit: 5 } })
  })

  it('help for an unknown command is still an unknown command', () => {
    expect(usage('frobnicate', '--help')).toBe('Unknown command: frobnicate. See `help`.')
    expect(usage('help', 'frobnicate')).toBe('Unknown command: frobnicate. See `help`.')
    expect(parseInvocation(['money', '--help'])).toMatchObject({ kind: 'help' })
    expect(parseInvocation(['help', 'senders'])).toMatchObject({ kind: 'help' })
  })

  it('takes everything after -- as arguments, for a file whose name starts with a dash', () => {
    expect(command('money', 'import', '--confirm', '--', '-statement.csv')).toMatchObject({
      command: { name: 'money import', file: '-statement.csv' },
    })
  })
})

describe('commandFrom', () => {
  it('validates programmatic input with the CLI rules (used by the MCP server)', () => {
    expect(commandFrom('senders', { limit: 3 })).toEqual({ name: 'senders', limit: 3 })
    expect(() => commandFrom('history', { limit: -1 })).toThrow(UsageError)
  })
})

it('marks exactly the commands that change data', () => {
  expect([...CHANGE_COMMANDS].sort()).toEqual([
    'ai sort',
    'boards add-card',
    'boards move-card',
    'calendar add',
    'calendar delete',
    'calendar edit',
    'cleanup run',
    'mail flag',
    'mail mark',
    'mail move',
    'mail undo',
    'money import',
    'money sort',
    'undo',
  ])
})
