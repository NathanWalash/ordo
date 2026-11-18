import { describe, expect, it } from 'vitest'
import { planBodyParts, referencedCids, safeFilename, type BodyNode } from './mime'

describe('planBodyParts', () => {
  it('reads a single-part plain text message as part 1', () => {
    expect(planBodyParts({ type: 'text/plain', size: 10 })).toEqual({
      html: null,
      text: '1',
      attachments: [],
    })
  })

  it('picks both bodies of multipart/alternative', () => {
    const root: BodyNode = {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'text/html' },
      ],
    }
    expect(planBodyParts(root)).toEqual({ html: '2', text: '1', attachments: [] })
  })

  it('lists attachments, keeps inline images with a Content-ID inline, and names unnamed ones', () => {
    const root: BodyNode = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/related',
          childNodes: [
            { part: '1.1', type: 'text/html' },
            { part: '1.2', type: 'image/png', id: '<logo@x>', disposition: 'inline', size: 120 },
          ],
        },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'Invoice.pdf' },
          size: 5000,
        },
        { part: '3', type: 'message/rfc822', size: 900 },
        { part: '4', type: 'text/plain', disposition: 'attachment', parameters: { name: 'notes.txt' } },
      ],
    }
    const plan = planBodyParts(root)
    expect(plan.html).toBe('1.1')
    expect(plan.text).toBeNull()
    expect(plan.attachments).toEqual([
      {
        part: '1.2',
        filename: 'attachment.png',
        contentType: 'image/png',
        size: 120,
        contentId: 'logo@x',
        inline: true,
      },
      { part: '2', filename: 'Invoice.pdf', contentType: 'application/pdf', size: 5000, inline: false },
      { part: '3', filename: 'attachment.eml', contentType: 'message/rfc822', size: 900, inline: false },
      { part: '4', filename: 'notes.txt', contentType: 'text/plain', size: 0, inline: false },
    ])
  })

  it('skips a second unnamed text part rather than listing it', () => {
    const plan = planBodyParts({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'text/plain' },
      ],
    })
    expect(plan).toEqual({ html: null, text: '1', attachments: [] })
  })
})

describe('safeFilename', () => {
  it('drops folders, control and bidi characters and leading dots', () => {
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFilename('..hidden')).toBe('hidden')
    expect(safeFilename('in\u202Ecod.exe')).toBe('incod.exe')
    expect(safeFilename('a\r\nb.txt')).toBe('ab.txt')
    expect(safeFilename('C:\\Windows\\x.dll')).toBe('C__Windows_x.dll')
  })

  it('falls back when nothing is left and keeps the extension when shortening', () => {
    expect(safeFilename(undefined)).toBe('attachment')
    expect(safeFilename(' . ', 'file.pdf')).toBe('file.pdf')
    const long = `${'x'.repeat(300)}.pdf`
    expect(safeFilename(long)).toHaveLength(200)
    expect(safeFilename(long).endsWith('.pdf')).toBe(true)
  })
})

describe('referencedCids', () => {
  it('finds cid: references, decoded and lower-cased', () => {
    expect(referencedCids('<img src="cid:Logo@X"><img src=\'cid:a%40b\'>')).toEqual(
      new Set(['logo@x', 'a@b']),
    )
  })
})
