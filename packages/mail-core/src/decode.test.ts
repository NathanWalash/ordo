import { describe, expect, it } from 'vitest'
import {
  decodeCharset,
  decodeQuotedPrintable,
  decodeTextPart,
  decodeTransfer,
  findPart,
  unflow,
} from './decode'

const bytes = (s: string) => Buffer.from(s, 'latin1')

describe('decodeQuotedPrintable', () => {
  it('decodes =XX bytes and soft line breaks, and leaves stray = alone', () => {
    expect(
      Buffer.from(decodeQuotedPrintable(bytes('caf=C3=A9 =\r\nau lait=\n!= =ZZ'))).toString('utf8'),
    ).toBe('café au lait!= =ZZ')
    expect(Buffer.from(decodeQuotedPrintable(bytes('a=  \r\nb'))).toString()).toBe('ab')
  })
})

describe('decodeTransfer', () => {
  it('handles base64 with line breaks, quoted-printable and 7bit', () => {
    expect(decodeTransfer(bytes('aGVs\r\nbG8='), 'BASE64').toString()).toBe('hello')
    expect(decodeTransfer(bytes('a=3Db'), 'quoted-printable').toString()).toBe('a=b')
    expect(decodeTransfer(bytes('plain'), undefined).toString()).toBe('plain')
  })
})

describe('decodeCharset', () => {
  it('reads Latin-1, Windows-1252 and UTF-8, and falls back to UTF-8', () => {
    expect(decodeCharset(Buffer.from([0xa3, 0x35]), 'ISO-8859-1')).toBe('£5')
    expect(decodeCharset(Buffer.from([0x93, 0x68, 0x94]), 'windows-1252')).toBe('“h”')
    expect(decodeCharset(Buffer.from('£5', 'utf8'), undefined)).toBe('£5')
    expect(decodeCharset(Buffer.from('£5', 'utf8'), 'x-made-up')).toBe('£5')
  })
})

describe('unflow', () => {
  it('joins soft line breaks but keeps the signature separator', () => {
    expect(unflow('This is \r\nflowed.\r\n-- \r\nSam', false)).toBe('This is flowed.\n-- \nSam')
    expect(unflow('Del \nSp', true)).toBe('DelSp')
  })

  it('joins quoted lines only at the same depth, without the next line’s ">" in the middle', () => {
    expect(unflow('> Are you free \r\n> on Friday?\r\n>> Older \r\n>> text\r\nMine', false)).toBe(
      '> Are you free on Friday?\n>> Older text\nMine',
    )
    // A soft break into a line of a different depth doesn't join.
    expect(unflow('> quoted \r\nnot quoted', false)).toBe('> quoted \nnot quoted')
  })

  it('undoes space-stuffing', () => {
    expect(unflow(' From here\r\n >not a quote', false)).toBe('From here\n>not a quote')
  })
})

describe('decodeTextPart', () => {
  it('uses the encoding, charset and format from BODYSTRUCTURE', () => {
    expect(
      decodeTextPart(bytes('Price =A35 \r\nonly'), {
        encoding: 'quoted-printable',
        parameters: { charset: 'iso-8859-1', format: 'flowed' },
      }),
    ).toBe('Price £5 only')
  })
})

describe('findPart', () => {
  it('finds a leaf by part number, and part 1 of a single-part message', () => {
    const root = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'multipart/related', childNodes: [{ part: '2.1', type: 'text/html' }] },
      ],
    }
    expect(findPart(root, '2.1')?.type).toBe('text/html')
    expect(findPart(root, '2')).toBeNull()
    expect(findPart({ type: 'text/plain' }, '1')?.type).toBe('text/plain')
  })
})
