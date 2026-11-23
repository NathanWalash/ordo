/**
 * The `.ordobackup` file format: one encrypted file holding snapshots of Ordo's databases and
 * settings. Pure Node (crypto, zlib, fs): no Electron, so it's tested directly.
 *
 * Layout (version 1):
 *
 * ```
 * header      64 bytes   magic "ORDOBKUP", u16 version, KDF id, scrypt logN/r/p, salt, IV, verifier
 * ciphertext  n bytes    AES-256-GCM over gzip(payload), with the whole header as additional data
 * tag         16 bytes   the GCM authentication tag
 * end         8 bytes    "ORDOEND1", so a half-synced or cut-off file says so
 * ```
 *
 * The payload is a u32 (big-endian) manifest length, the manifest as JSON, then each file's bytes
 * in manifest order. The key comes from the passphrase with scrypt and a random salt per file;
 * scrypt gives 64 bytes, the first 32 are the AES key and the last 32 make the verifier, an HMAC of
 * the header that tells a wrong passphrase apart from a damaged file before anything is decrypted.
 * Every byte of the header is authenticated, so changing the version, salt or scrypt settings
 * fails just like changing the ciphertext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { z } from 'zod'

export const FORMAT_VERSION = 1
export const MAGIC = Buffer.from('ORDOBKUP', 'ascii')
export const END_MARKER = Buffer.from('ORDOEND1', 'ascii')
export const HEADER_SIZE = 64
const TAG_SIZE = 16
const KDF_SCRYPT = 1

/** scrypt cost: N = 2^logN. */
export interface ScryptParams {
  logN: number
  r: number
  p: number
}

/** OWASP's recommendation for scrypt: N = 2^17, r = 8, p = 1 (128 MiB, about a third of a second). */
export const DEFAULT_SCRYPT: ScryptParams = { logN: 17, r: 8, p: 1 }

/**
 * What a file may ask for. A crafted header can't make Ordo spend more than 1 GiB or more than a
 * few seconds deriving a key.
 */
function scryptProblem({ logN, r, p }: ScryptParams): string | null {
  if (!Number.isInteger(logN) || logN < 10 || logN > 20) return 'scrypt N out of range'
  if (!Number.isInteger(r) || r < 1 || r > 32) return 'scrypt r out of range'
  if (!Number.isInteger(p) || p < 1 || p > 4) return 'scrypt p out of range'
  if (128 * 2 ** logN * r > 1024 ** 3) return 'scrypt memory out of range'
  return null
}

export type BackupErrorCode =
  'not-backup' | 'newer-version' | 'wrong-passphrase' | 'damaged' | 'truncated' | 'no-space'

const MESSAGES: Record<BackupErrorCode, string> = {
  'not-backup': 'That file isn’t an Ordo backup.',
  'newer-version': 'This backup was made by a newer version of Ordo. Update Ordo, then try again.',
  'wrong-passphrase': 'That passphrase doesn’t open this backup. Check it and try again.',
  damaged: 'This backup is damaged or has been changed since Ordo made it, so it can’t be restored.',
  truncated:
    'This backup file is incomplete. If it’s in a cloud folder it may still be downloading: wait for it to finish, then try again.',
  'no-space': 'There isn’t enough free disk space to restore this backup. Free some space, then try again.',
}

/** A backup that can't be opened, with a message to show as it is. */
export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message = MESSAGES[code],
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

/** Passphrases are compared as typed, after Unicode normalisation (so é is é however it was typed). */
const passphraseBytes = (passphrase: string) => Buffer.from(passphrase.normalize('NFC'), 'utf8')

/** scrypt, off the main thread (libuv's pool). */
export function deriveBytes(
  passphrase: string,
  salt: Buffer,
  length: number,
  params: ScryptParams,
): Promise<Buffer> {
  const problem = scryptProblem(params)
  if (problem) return Promise.reject(new Error(problem))
  const N = 2 ** params.logN
  return new Promise((resolve, reject) =>
    scrypt(
      passphraseBytes(passphrase),
      salt,
      length,
      { N, r: params.r, p: params.p, maxmem: 128 * N * params.r + 16 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  )
}

// ---------------------------------------------------------------------------------------------
// Passphrase check: what Ordo keeps to know the passphrase you type is the one you set.

/** A salted scrypt hash of the passphrase. Not the passphrase; can't be turned back into it. */
export const PassphraseCheckSchema = z.strictObject({
  salt: z.base64(),
  logN: z.int(),
  r: z.int(),
  p: z.int(),
  hash: z.base64(),
})
export type PassphraseCheck = z.infer<typeof PassphraseCheckSchema>

export async function makePassphraseCheck(
  passphrase: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<PassphraseCheck> {
  const salt = randomBytes(16)
  const hash = await deriveBytes(passphrase, salt, 32, params)
  return { salt: salt.toString('base64'), ...params, hash: hash.toString('base64') }
}

export async function passphraseMatches(passphrase: string, check: PassphraseCheck): Promise<boolean> {
  const expected = Buffer.from(check.hash, 'base64')
  const { salt, logN, r, p } = check
  const got = await deriveBytes(passphrase, Buffer.from(salt, 'base64'), expected.length, { logN, r, p })
  return got.length === expected.length && timingSafeEqual(got, expected)
}

// ---------------------------------------------------------------------------------------------
// Header

export interface Header {
  version: number
  scrypt: ScryptParams
  salt: Buffer
  iv: Buffer
  verifier: Buffer
  /** All 64 bytes, used as the GCM additional data. */
  raw: Buffer
}

function encodeHeader(scryptParams: ScryptParams, salt: Buffer, iv: Buffer, verifier: Buffer): Buffer {
  const h = Buffer.alloc(HEADER_SIZE)
  MAGIC.copy(h, 0)
  h.writeUInt16BE(FORMAT_VERSION, 8)
  h.writeUInt8(KDF_SCRYPT, 10)
  h.writeUInt8(scryptParams.logN, 11)
  h.writeUInt32BE(scryptParams.r, 12)
  h.writeUInt32BE(scryptParams.p, 16)
  salt.copy(h, 20)
  iv.copy(h, 36)
  verifier.copy(h, 48)
  return h
}

/** Check and decode a header. Throws BackupError. */
export function parseHeader(raw: Buffer): Header {
  if (raw.length < 10 || !raw.subarray(0, 8).equals(MAGIC)) throw new BackupError('not-backup')
  const version = raw.readUInt16BE(8)
  if (version > FORMAT_VERSION) throw new BackupError('newer-version')
  if (version !== FORMAT_VERSION) throw new BackupError('not-backup')
  if (raw.length < HEADER_SIZE) throw new BackupError('truncated')
  if (raw.readUInt8(10) !== KDF_SCRYPT) throw new BackupError('damaged')
  const scryptParams = { logN: raw.readUInt8(11), r: raw.readUInt32BE(12), p: raw.readUInt32BE(16) }
  if (scryptProblem(scryptParams)) throw new BackupError('damaged')
  return {
    version,
    scrypt: scryptParams,
    salt: Buffer.from(raw.subarray(20, 36)),
    iv: Buffer.from(raw.subarray(36, 48)),
    verifier: Buffer.from(raw.subarray(48, 64)),
    raw: Buffer.from(raw.subarray(0, HEADER_SIZE)),
  }
}

/** The AES key and the verifier for a header (whose verifier bytes are ignored). */
async function keysFor(passphrase: string, header: Buffer, params: ScryptParams, salt: Buffer) {
  const bytes = await deriveBytes(passphrase, salt, 64, params)
  const key = bytes.subarray(0, 32)
  const verifier = createHmac('sha256', bytes.subarray(32))
    .update('ordo-backup-verifier')
    .update(header.subarray(0, 48))
    .digest()
    .subarray(0, 16)
  return { key, verifier }
}

// ---------------------------------------------------------------------------------------------
// Manifest

/** The files a backup may hold. Restoring refuses any other name (no paths, no surprises). */
export const BACKUP_FILES = [
  'mail.sqlite',
  'calendar.sqlite',
  'money.sqlite',
  'boards.sqlite',
  'settings.json',
  'assistant.json',
] as const
export type BackupFileName = (typeof BACKUP_FILES)[number]

const MAX_MANIFEST_BYTES = 1024 * 1024

export const ManifestSchema = z.strictObject({
  format: z.literal(FORMAT_VERSION),
  app: z.literal('Ordo'),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.-]+)?$/),
  createdAt: z.iso.datetime({ offset: true }),
  /** The account the mail cache belongs to (never its password), or null. */
  account: z.strictObject({ email: z.string().max(320) }).nullable(),
  files: z
    .array(
      z.strictObject({
        name: z.enum(BACKUP_FILES),
        size: z.int().min(0),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .max(BACKUP_FILES.length)
    .refine((files) => new Set(files.map((f) => f.name)).size === files.length, 'Duplicate file'),
  /** What was deliberately left out, for people reading the manifest. */
  excluded: z.array(z.string().max(200)).max(20),
})
export type Manifest = z.infer<typeof ManifestSchema>

/** SHA-256 and size of a file, streamed. */
export async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    size += chunk.length
  }
  return { size, sha256: hash.digest('hex') }
}

// ---------------------------------------------------------------------------------------------
// Writing

export interface WriteBackupOptions {
  /** Folder holding the snapshot files named in `files`. */
  sourceDir: string
  files: readonly BackupFileName[]
  /** Where the finished backup goes. It's written beside it as `<out>.partial` first. */
  out: string
  passphrase: string
  appVersion: string
  createdAt: Date
  account: { email: string } | null
  excluded?: string[]
  scrypt?: ScryptParams
}

/** Write an encrypted backup of the files in `sourceDir`. Returns the manifest and file size. */
export async function writeBackup(
  options: WriteBackupOptions,
): Promise<{ manifest: Manifest; size: number }> {
  const params = options.scrypt ?? DEFAULT_SCRYPT
  const files: Manifest['files'] = []
  for (const name of options.files) files.push({ name, ...(await hashFile(join(options.sourceDir, name))) })
  const manifest = ManifestSchema.parse({
    format: FORMAT_VERSION,
    app: 'Ordo',
    appVersion: options.appVersion,
    createdAt: options.createdAt.toISOString(),
    account: options.account,
    files,
    excluded: options.excluded ?? [],
  } satisfies Manifest)

  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const draft = encodeHeader(params, salt, iv, Buffer.alloc(16))
  const { key, verifier } = await keysFor(options.passphrase, draft, params, salt)
  const header = encodeHeader(params, salt, iv, verifier)

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(manifestJson.length)

  async function* payload() {
    yield length
    yield manifestJson
    for (const f of manifest.files) {
      let seen = 0
      for await (const chunk of createReadStream(join(options.sourceDir, f.name)) as AsyncIterable<Buffer>) {
        seen += chunk.length
        yield chunk
      }
      // A snapshot that changed under us would make a backup that fails its own checks.
      if (seen !== f.size) throw new Error(`${f.name} changed while it was being backed up`)
    }
  }

  const partial = `${options.out}.partial`
  try {
    const out = createWriteStream(partial, { mode: 0o600 })
    out.write(header)
    await pipeline(Readable.from(payload()), createGzip({ level: 6 }), cipher, out)
    const fh = await open(partial, 'a')
    try {
      await fh.write(Buffer.concat([cipher.getAuthTag(), END_MARKER]))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(partial, options.out)
  } catch (err) {
    await rm(partial, { force: true })
    throw err
  }
  return { manifest, size: (await stat(options.out)).size }
}

// ---------------------------------------------------------------------------------------------
// Reading

async function readRange(path: string, position: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, position)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Read and check a backup's header without the passphrase (is it a backup, and which version). */
export async function readHeader(path: string): Promise<Header> {
  return parseHeader(await readRange(path, 0, HEADER_SIZE))
}

/**
 * Splits the decrypted, decompressed payload into the manifest and the files, writing each file
 * into `dir` and checking its size and SHA-256 against the manifest.
 */
class PayloadWriter extends Writable {
  manifest: Manifest | null = null
  /** Files this writer created, to remove if the backup turns out to be bad. */
  readonly created: string[] = []
  private buffered = Buffer.alloc(0)
  private manifestLength = -1
  private index = 0
  private current: { fh: FileHandle; hash: ReturnType<typeof createHash> } | null = null
  private left = 0

  constructor(
    private readonly dir: string,
    /** The most the files together may be, checked against the manifest before any is written. */
    private readonly maxBytes: number,
  ) {
    super()
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    this.take(chunk).then(() => done(), done)
  }

  override _final(done: (err?: Error | null) => void): void {
    this.finish().then(() => done(), done)
  }

  private async take(chunk: Buffer): Promise<void> {
    let data = chunk
    if (!this.manifest) {
      this.buffered = Buffer.concat([this.buffered, data])
      if (this.manifestLength < 0) {
        if (this.buffered.length < 4) return
        this.manifestLength = this.buffered.readUInt32BE(0)
        if (this.manifestLength > MAX_MANIFEST_BYTES) throw new BackupError('damaged')
      }
      if (this.buffered.length < 4 + this.manifestLength) return
      let parsed: unknown
      try {
        parsed = JSON.parse(this.buffered.subarray(4, 4 + this.manifestLength).toString('utf8'))
      } catch {
        throw new BackupError('damaged')
      }
      const result = ManifestSchema.safeParse(parsed)
      if (!result.success) throw new BackupError('damaged')
      if (result.data.files.reduce((sum, f) => sum + f.size, 0) > this.maxBytes)
        throw new BackupError('no-space')
      this.manifest = result.data
      data = this.buffered.subarray(4 + this.manifestLength)
      this.buffered = Buffer.alloc(0)
      await this.next()
    }
    while (data.length > 0) {
      if (!this.current) throw new BackupError('damaged') // more bytes than the manifest lists
      const part = data.subarray(0, this.left)
      data = data.subarray(part.length)
      this.current.hash.update(part)
      await this.current.fh.write(part)
      this.left -= part.length
      if (this.left === 0) await this.next()
    }
  }

  /** Close the file being written (checking it) and open the next, skipping empty ones. */
  private async next(): Promise<void> {
    const files = this.manifest!.files
    while (true) {
      if (this.current) {
        const f = files[this.index - 1]!
        const { fh, hash } = this.current
        this.current = null
        await fh.sync()
        await fh.close()
        if (hash.digest('hex') !== f.sha256) throw new BackupError('damaged')
      }
      if (this.index >= files.length) return
      const f = files[this.index++]!
      const path = join(this.dir, f.name)
      this.current = { fh: await open(path, 'wx', 0o600), hash: createHash('sha256') }
      this.created.push(path)
      this.left = f.size
      if (this.left > 0) return
    }
  }

  private async finish(): Promise<void> {
    if (!this.manifest || this.current || this.index < this.manifest.files.length)
      throw new BackupError('damaged')
  }

  override _destroy(err: Error | null, done: (err?: Error | null) => void): void {
    const open = this.current
    this.current = null
    if (open)
      open.fh.close().then(
        () => done(err),
        () => done(err),
      )
    else done(err)
  }
}

/** Counts bytes through a stream, to cap what a crafted file can decompress to. */
function limit(maxBytes: number): Transform {
  let total = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length
      done(total > maxBytes ? new BackupError('damaged') : null, chunk)
    },
  })
}

export interface OpenBackupOptions {
  /** A folder to write the restored files into. Created if missing; existing files are never replaced. */
  into: string
  /**
   * The most the restored files may add up to, such as the free space where they go. A manifest
   * declaring more is refused (`no-space`) before anything is written, and no file may be longer
   * than the manifest says. Default 64 GiB.
   */
  maxBytes?: number
}

/**
 * Decrypt a backup into a folder, checking the passphrase, the authentication tag and every
 * file's SHA-256. Throws BackupError; on any failure the files written so far are removed, so
 * nothing unauthenticated is left behind.
 */
export async function openBackup(
  path: string,
  passphrase: string,
  options: OpenBackupOptions,
): Promise<Manifest> {
  const { size } = await stat(path)
  const header = await readHeader(path)
  if (size < HEADER_SIZE + TAG_SIZE + END_MARKER.length) throw new BackupError('truncated')
  const tail = await readRange(path, size - TAG_SIZE - END_MARKER.length, TAG_SIZE + END_MARKER.length)
  if (!tail.subarray(TAG_SIZE).equals(END_MARKER)) throw new BackupError('truncated')

  const { key, verifier } = await keysFor(passphrase, header.raw, header.scrypt, header.salt)
  if (!timingSafeEqual(verifier, header.verifier)) throw new BackupError('wrong-passphrase')

  const decipher = createDecipheriv('aes-256-gcm', key, header.iv)
  decipher.setAAD(header.raw)
  decipher.setAuthTag(tail.subarray(0, TAG_SIZE))

  await mkdir(options.into, { recursive: true, mode: 0o700 })
  const maxBytes = options.maxBytes ?? 64 * 1024 ** 3
  const writer = new PayloadWriter(options.into, maxBytes)
  try {
    const end = size - TAG_SIZE - END_MARKER.length - 1
    await pipeline(
      end >= HEADER_SIZE ? createReadStream(path, { start: HEADER_SIZE, end }) : Readable.from([]),
      decipher,
      createGunzip(),
      // The writer holds each file to its declared size; this also caps the manifest part.
      limit(maxBytes + 4 + MAX_MANIFEST_BYTES),
      writer,
    )
  } catch (err) {
    await Promise.all(writer.created.map((f) => rm(f, { force: true })))
    // A bad tag, bad gzip or bad layout all mean the same thing to the person restoring.
    throw err instanceof BackupError ? err : new BackupError('damaged')
  }
  return writer.manifest!
}
