import { describe, expect, it } from 'vitest'
import {
  ATTACHMENTS_MAX,
  budgetParts,
  chooseInlineImages,
  INLINE_IMAGES_MAX,
  planBodyParts,
  referencedCids,
  safeFilename,
  type BodyNode,
} from './mime'

/** An attached email, the way imapflow reports it: with the inner message's own parts. */
const attachedEmail = (part: string): BodyNode => ({
  part,
  type: 'message/rfc822',
  size: 900,
  childNodes: [
    {
      part: `${part}.1`,
      type: 'multipart/alternative',
      childNodes: [
        { part: `${part}.1.1`, type: 'text/plain' },
        { part: `${part}.1.2`, type: 'text/html' },
      ],
    },
  ],
})

describe('planBodyParts', () => {
  it('reads a single-part plain text message as part 1', () => {
    expect(planBodyParts({ type: 'text/plain', size: 10 })).toEqual({
      html: [],
      text: ['1'],
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
    expect(planBodyParts(root)).toEqual({ html: ['2'], text: ['1'], attachments: [] })
  })

  it('lists attachments, keeps inline images with a Content-ID inline, and names unnamed ones', () => {
    const root: BodyNode = {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
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
        attachedEmail('3'),
        { part: '4', type: 'text/plain', disposition: 'attachment', parameters: { name: 'notes.txt' } },
      ],
    }
    const plan = planBodyParts(root)
    expect(plan.html).toEqual(['1.1'])
    expect(plan.text).toEqual([])
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

  it('shows a bounce’s own notice, not the returned message inside it', () => {
    const bounce: BodyNode = {
      type: 'multipart/report',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'message/delivery-status', size: 300 },
        attachedEmail('3'),
      ],
    }
    const plan = planBodyParts(bounce)
    expect(plan.html).toEqual([])
    expect(plan.text).toEqual(['1'])
    expect(plan.attachments.map((a) => [a.part, a.contentType])).toEqual([
      ['2', 'message/delivery-status'],
      ['3', 'message/rfc822'],
    ])
  })

  it('a message forwarded as an attachment is a file, not the body', () => {
    const plan = planBodyParts({
      type: 'multipart/mixed',
      childNodes: [{ part: '1', type: 'text/plain' }, attachedEmail('2')],
    })
    expect(plan).toMatchObject({
      html: [],
      text: ['1'],
      attachments: [{ part: '2', filename: 'attachment.eml' }],
    })
  })

  it('keeps every inline text part in order, as Apple Mail sends html, pdf, html', () => {
    const plan = planBodyParts({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/html' },
        { part: '2', type: 'application/pdf', disposition: 'inline', parameters: { name: 'a.pdf' } },
        { part: '3', type: 'text/html' },
        { part: '4', type: 'text/plain' },
        { part: '5', type: 'text/plain' },
      ],
    })
    expect(plan.html).toEqual(['1', '3'])
    expect(plan.text).toEqual(['4', '5'])
    expect(plan.attachments.map((a) => a.part)).toEqual(['2'])
  })

  it('limits inline images and attachments, so one email can’t tie Ordo up', () => {
    const images = Array.from({ length: INLINE_IMAGES_MAX + 10 }, (_, i) => ({
      part: `1.${i + 2}`,
      type: 'image/png',
      id: `<i${i}@x>`,
    }))
    const files = Array.from({ length: ATTACHMENTS_MAX + 10 }, (_, i) => ({
      part: `${i + 2}`,
      type: 'application/pdf',
      disposition: 'attachment',
    }))
    const plan = planBodyParts({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'multipart/related', childNodes: [{ part: '1.1', type: 'text/html' }, ...images] },
        ...files,
      ],
    })
    expect(plan.attachments.filter((a) => a.inline)).toHaveLength(INLINE_IMAGES_MAX)
    expect(plan.attachments.length).toBeLessThanOrEqual(ATTACHMENTS_MAX)
  })
})

describe('budgetParts', () => {
  it('shares one byte budget across all the parts, using their reported sizes', () => {
    const nodes = [
      { part: '1', size: 400 },
      { part: '2', size: 500 },
      { part: '3', size: 300 },
      { part: '4', size: 10 },
    ]
    expect(budgetParts(nodes, 1000)).toEqual({
      fetch: [
        { key: '1', maxLength: 400 },
        { key: '2', maxLength: 500 },
        { key: '3', maxLength: 100 },
      ],
      truncated: true,
    })
    expect(budgetParts(nodes.slice(0, 2), 1000)).toEqual({
      fetch: [
        { key: '1', maxLength: 400 },
        { key: '2', maxLength: 500 },
      ],
      truncated: false,
    })
  })

  it('never asks for more than the budget in all, even for parts of unknown size', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ part: String(i + 1) }))
    const r = budgetParts(many, 1000)
    expect(r.fetch.reduce((n, p) => n + p.maxLength, 0)).toBeLessThanOrEqual(1000)
    expect(r.truncated).toBe(true)
  })
})

describe('chooseInlineImages', () => {
  it('lists the inline images it won’t show as attachments instead of dropping them', () => {
    const img = (part: string, contentId: string, contentType = 'image/png', size = 100) => ({
      part,
      filename: `${part}.png`,
      contentType,
      size,
      contentId,
      inline: true,
    })
    const all = [
      img('1', 'used'),
      img('2', 'unused'),
      img('3', 'tiff', 'image/tiff'),
      img('4', 'huge', 'image/png', 4000),
      img('5', 'also'),
    ]
    const chosen = chooseInlineImages(all, new Set(['used', 'tiff', 'huge', 'also']), 1000)
    expect(chosen.map((a) => a.part)).toEqual(['1', '5'])
    expect(all.map((a) => a.inline)).toEqual([true, false, false, false, true])
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
