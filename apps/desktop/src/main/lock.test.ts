import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { busyMessage, processAlive, WriteLock } from './lock'

let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'ordo-lock-')), 'ordo-write.lock')
})

/** A PID that certainly isn't running: a child process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid!
}

describe('WriteLock', () => {
  it('writes the holder to the file and removes it on release', () => {
    const lock = new WriteLock(file, { owner: 'headless' })
    const got = lock.tryAcquire('scanning your inbox')
    expect(got.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      pid: process.pid,
      owner: 'headless',
      task: 'scanning your inbox',
    })
    if (got.ok) got.release()
    expect(existsSync(file)).toBe(false)
  })

  it('refuses while another live process holds it', () => {
    const other = new WriteLock(file, { owner: 'app', pid: 4242, isAlive: () => true })
    expect(other.tryAcquire('syncing your calendars').ok).toBe(true)
    const me = new WriteLock(file, { owner: 'headless', isAlive: () => true })
    const got = me.tryAcquire('scanning your inbox')
    expect(got).toEqual({
      ok: false,
      holder: expect.objectContaining({ pid: 4242, owner: 'app', task: 'syncing your calendars' }),
    })
    // Refusing never removes someone else's lock.
    expect(existsSync(file)).toBe(true)
  })

  it('is re-entrant inside one process and only releases on the last release', () => {
    const lock = new WriteLock(file, { owner: 'app' })
    const a = lock.tryAcquire('scanning your inbox')
    const b = lock.tryAcquire('syncing your calendars')
    expect(a.ok && b.ok).toBe(true)
    if (a.ok) a.release()
    if (a.ok) a.release() // releasing twice is a no-op
    expect(existsSync(file)).toBe(true)
    if (b.ok) b.release()
    expect(existsSync(file)).toBe(false)
  })

  it('takes over a lock left by a process that has exited', () => {
    const pid = deadPid()
    expect(processAlive(pid)).toBe(false)
    writeFileSync(
      file,
      JSON.stringify({ pid, owner: 'mcp', task: 'clearing senders', since: new Date().toISOString() }),
    )
    const lock = new WriteLock(file, { owner: 'headless' })
    const got = lock.tryAcquire('scanning your inbox')
    expect(got.ok).toBe(true)
    expect(lock.holder()).toMatchObject({ pid: process.pid, owner: 'headless' })
  })

  it('takes over a lock older than the maximum age even if the PID is in use again', () => {
    writeFileSync(
      file,
      JSON.stringify({ pid: 4242, owner: 'app', task: 'x', since: '2026-01-01T00:00:00.000Z' }),
    )
    const lock = new WriteLock(file, {
      owner: 'headless',
      isAlive: () => true,
      now: () => new Date('2026-01-01T07:00:00.000Z'),
    })
    expect(lock.tryAcquire('scanning your inbox').ok).toBe(true)
  })

  it('takes over a lock carrying its own PID from an earlier process', () => {
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, owner: 'app', task: 'x', since: new Date().toISOString() }),
    )
    expect(new WriteLock(file, { owner: 'headless' }).tryAcquire('y').ok).toBe(true)
  })

  it('waits on an unreadable lock that was just written, and takes over an old one', () => {
    writeFileSync(file, '')
    const lock = new WriteLock(file, { owner: 'headless' })
    expect(lock.tryAcquire('x')).toEqual({ ok: false, holder: null })
    const old = new Date(Date.now() - 60_000)
    utimesSync(file, old, old)
    expect(lock.tryAcquire('x').ok).toBe(true)
  })

  it('releaseAll removes the file whatever the count', () => {
    const lock = new WriteLock(file, { owner: 'app' })
    lock.tryAcquire('a')
    lock.tryAcquire('b')
    lock.releaseAll()
    expect(existsSync(file)).toBe(false)
    expect(lock.held).toBe(false)
  })
})

describe('busyMessage', () => {
  it('names who is busy and what they are doing', () => {
    expect(
      busyMessage({ pid: 1, owner: 'mcp', task: 'clearing senders', since: '2026-01-01T00:00:00Z' }),
    ).toBe('Ordo is busy in an AI agent using Ordo (clearing senders). Try again when it finishes.')
    expect(busyMessage(null)).toBe(
      'Ordo is busy in another Ordo window or agent. Try again when it finishes.',
    )
  })

  it('strips anything odd from the task on disk', () => {
    expect(
      busyMessage({ pid: 1, owner: 'app', task: 'a\u001b[31m<b>\n', since: '2026-01-01T00:00:00Z' }),
    ).toBe('Ordo is busy in another Ordo window (a31mb). Try again when it finishes.')
  })
})
