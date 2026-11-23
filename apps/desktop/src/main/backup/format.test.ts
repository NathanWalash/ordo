import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BackupError,
  END_MARKER,
  FORMAT_VERSION,
  HEADER_SIZE,
  makePassphraseCheck,
  openBackup,
  parseHeader,
  passphraseMatches,
  readHeader,
  writeBackup,
  type BackupFileName,
  type ScryptParams,
} from './format'

/** Cheap scrypt settings so the tests are quick; the format stores them in each file. */
const FAST: ScryptParams = { logN: 10, r: 8, p: 1 }
const PASS = 'correct horse battery staple'

let dir: string
let source: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordo-backup-format-'))
  source = join(dir, 'source')
  mkdirSync(source)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Synthetic profile files, including an empty one and one bigger than a stream chunk. */
function seed(): BackupFileName[] {
  writeFileSync(join(source, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  writeFileSync(join(source, 'assistant.json'), '')
  const big = Buffer.alloc(300_000)
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251
  writeFileSync(join(source, 'mail.sqlite'), big)
  return ['mail.sqlite', 'settings.json', 'assistant.json']
}

async function backup(passphrase = PASS, out = join(dir, 'b.ordobackup')) {
  const files = seed()
  const result = await writeBackup({
    sourceDir: source,
    files,
    out,
    passphrase,
    appVersion: '0.1.0',
    createdAt: new Date('2026-11-23T14:02:00Z'),
    account: { email: 'someone@ordo.test' },
    excluded: ['account.json'],
    scrypt: FAST,
  })
  return { out, files, ...result }
}

async function expectError(promise: Promise<unknown>, code: BackupError['code']) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(BackupError)
  expect((err as BackupError).code).toBe(code)
  expect((err as BackupError).message.length).toBeGreaterThan(10)
}

describe('backup format', () => {
  it('round-trips every file byte for byte, with a manifest', async () => {
    const { out, manifest, size } = await backup()
    expect(size).toBe(readFileSync(out).length)
    expect(manifest).toMatchObject({
      format: FORMAT_VERSION,
      app: 'Ordo',
      appVersion: '0.1.0',
      createdAt: '2026-11-23T14:02:00.000Z',
      account: { email: 'someone@ordo.test' },
      excluded: ['account.json'],
    })
    expect(manifest.files.map((f) => [f.name, f.size])).toEqual([
      ['mail.sqlite', 300_000],
      ['settings.json', 16],
      ['assistant.json', 0],
    ])

    const into = join(dir, 'restored')
    const opened = await openBackup(out, PASS, { into })
    expect(opened).toEqual(manifest)
    for (const f of ['mail.sqlite', 'settings.json', 'assistant.json'])
      expect(readFileSync(join(into, f)).equals(readFileSync(join(source, f)))).toBe(true)
    expect(readdirSync(dir)).not.toContain('b.ordobackup.partial')
  })

  it('never writes the passphrase or the plain contents into the file', async () => {
    const { out } = await backup()
    const raw = readFileSync(out)
    expect(raw.includes(Buffer.from(PASS))).toBe(false)
    expect(raw.includes(Buffer.from('someone@ordo.test'))).toBe(false)
    expect(raw.includes(Buffer.from('"theme"'))).toBe(false)
    expect(raw.subarray(0, 8).toString()).toBe('ORDOBKUP')
    expect(raw.subarray(-8).equals(END_MARKER)).toBe(true)
  })

  it('uses a fresh salt and IV for every backup', async () => {
    const a = await backup(PASS, join(dir, 'a.ordobackup'))
    const b = await backup(PASS, join(dir, 'b2.ordobackup'))
    const [ha, hb] = [await readHeader(a.out), await readHeader(b.out)]
    expect(ha.salt.equals(hb.salt)).toBe(false)
    expect(ha.iv.equals(hb.iv)).toBe(false)
    expect(ha.scrypt).toEqual(FAST)
  })

  it('says so clearly when the passphrase is wrong, and leaves nothing behind', async () => {
    const { out } = await backup()
    const into = join(dir, 'restored')
    await expectError(openBackup(out, 'not the passphrase', { into }), 'wrong-passphrase')
    expect(() => readdirSync(into)).toThrow()
  })

  it('normalises the passphrase, so the same characters typed differently still open it', async () => {
    const { out } = await backup('café crème brûlée'.normalize('NFC'))
    await openBackup(out, 'café crème brûlée'.normalize('NFD'), { into: join(dir, 'r') })
  })

  it('refuses a file with any byte of the ciphertext changed', async () => {
    const { out } = await backup()
    const raw = readFileSync(out)
    for (const at of [HEADER_SIZE, HEADER_SIZE + 100, raw.length - 8 - 16 - 1]) {
      const bad = Buffer.from(raw)
      bad[at]! ^= 0x01
      const file = join(dir, `bad-${at}.ordobackup`)
      writeFileSync(file, bad)
      const into = join(dir, `r-${at}`)
      await expectError(openBackup(file, PASS, { into }), 'damaged')
      expect(readdirSync(into)).toEqual([])
    }
  })

  it('refuses a changed tag', async () => {
    const { out } = await backup()
    const bad = readFileSync(out)
    bad[bad.length - 8 - 1]! ^= 0x80
    writeFileSync(out, bad)
    await expectError(openBackup(out, PASS, { into: join(dir, 'r') }), 'damaged')
  })

  it('refuses a changed header (salt, IV or verifier), which is authenticated', async () => {
    const { out } = await backup()
    const raw = readFileSync(out)
    for (const at of [20, 40, 50]) {
      const bad = Buffer.from(raw)
      bad[at]! ^= 0x01
      writeFileSync(out, bad)
      const err = await openBackup(out, PASS, { into: join(dir, `r-${at}`) }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BackupError)
      // Salt or verifier changes look like the wrong passphrase; an IV change fails the tag.
      expect(['wrong-passphrase', 'damaged']).toContain((err as BackupError).code)
    }
  })

  it('says a cut-off file is incomplete (for example still syncing)', async () => {
    const { out } = await backup()
    const raw = readFileSync(out)
    for (const length of [raw.length - 1, raw.length - 30, HEADER_SIZE + 10, HEADER_SIZE]) {
      writeFileSync(out, raw.subarray(0, length))
      await expectError(openBackup(out, PASS, { into: join(dir, `r-${length}`) }), 'truncated')
    }
  })

  it('refuses a file cut short in the middle even if the end marker is kept', async () => {
    const { out } = await backup()
    const raw = readFileSync(out)
    writeFileSync(out, Buffer.concat([raw.subarray(0, 2000), raw.subarray(-24)]))
    await expectError(openBackup(out, PASS, { into: join(dir, 'r') }), 'damaged')
  })

  it('refuses a backup from a newer format, and files that are not backups', async () => {
    const { out } = await backup()
    const raw = readFileSync(out)
    const newer = Buffer.from(raw)
    newer.writeUInt16BE(FORMAT_VERSION + 1, 8)
    writeFileSync(out, newer)
    await expectError(openBackup(out, PASS, { into: join(dir, 'r1') }), 'newer-version')

    const older = Buffer.from(raw)
    older.writeUInt16BE(0, 8)
    writeFileSync(out, older)
    await expectError(openBackup(out, PASS, { into: join(dir, 'r2') }), 'not-backup')

    writeFileSync(out, 'PK\u0003\u0004 a zip file, not a backup')
    await expectError(openBackup(out, PASS, { into: join(dir, 'r3') }), 'not-backup')
    writeFileSync(out, '')
    await expectError(openBackup(out, PASS, { into: join(dir, 'r4') }), 'not-backup')
  })

  it('refuses scrypt settings that would take too much memory or time', () => {
    const h = Buffer.alloc(HEADER_SIZE)
    h.write('ORDOBKUP', 0, 'ascii')
    h.writeUInt16BE(FORMAT_VERSION, 8)
    h.writeUInt8(1, 10)
    for (const [logN, r, p] of [
      [25, 8, 1],
      [20, 32, 1],
      [17, 8, 99],
      [4, 8, 1],
    ] as const) {
      h.writeUInt8(logN, 11)
      h.writeUInt32BE(r, 12)
      h.writeUInt32BE(p, 16)
      expect(() => parseHeader(h)).toThrow(BackupError)
    }
    h.writeUInt8(17, 11)
    h.writeUInt32BE(8, 12)
    h.writeUInt32BE(1, 16)
    expect(parseHeader(h).scrypt).toEqual({ logN: 17, r: 8, p: 1 })
  })

  it('refuses to restore into a folder that already has the files (never overwrites)', async () => {
    const { out } = await backup()
    const into = join(dir, 'r')
    mkdirSync(into)
    writeFileSync(join(into, 'settings.json'), 'mine')
    await expect(openBackup(out, PASS, { into })).rejects.toBeInstanceOf(BackupError)
    expect(readFileSync(join(into, 'settings.json'), 'utf8')).toBe('mine')
  })

  it('caps how much a backup may decompress to', async () => {
    const { out } = await backup()
    await expectError(openBackup(out, PASS, { into: join(dir, 'r'), maxBytes: 1000 }), 'damaged')
  })
})

describe('passphrase check', () => {
  it('matches the passphrase it was made from and nothing else', async () => {
    const check = await makePassphraseCheck(PASS, FAST)
    expect(JSON.stringify(check)).not.toContain(PASS)
    expect(await passphraseMatches(PASS, check)).toBe(true)
    expect(await passphraseMatches(`${PASS} `, check)).toBe(false)
    expect(await passphraseMatches('', check)).toBe(false)
  })

  it('uses the strong default settings when none are given', async () => {
    const check = await makePassphraseCheck(PASS)
    expect(check).toMatchObject({ logN: 17, r: 8, p: 1 })
    expect(await passphraseMatches(PASS, check)).toBe(true)
  })
})
