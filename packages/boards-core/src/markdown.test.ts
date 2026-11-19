import { describe, expect, it } from 'vitest'
import { linkHostNote, MAX_NOTES, parseInline, parseMarkdown, plainText } from './markdown'

describe('parseInline', () => {
  it('reads bold, italic, code and links', () => {
    expect(
      parseInline('**Call** the *plumber* about `boiler-2` at [their site](https://plumb.example/x)'),
    ).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'Call' }] },
      { type: 'text', text: ' the ' },
      { type: 'em', children: [{ type: 'text', text: 'plumber' }] },
      { type: 'text', text: ' about ' },
      { type: 'code', text: 'boiler-2' },
      { type: 'text', text: ' at ' },
      { type: 'link', href: 'https://plumb.example/x', children: [{ type: 'text', text: 'their site' }] },
    ])
  })

  it('never makes links that aren’t https', () => {
    for (const href of [
      'javascript:alert(1)',
      'http://plain.example',
      'file:///etc/passwd',
      'data:text/html,hi',
    ])
      expect(parseInline(`[click](${href})`)).toEqual([{ type: 'text', text: 'click' }])
    expect(parseInline('[x](https://user:pw@evil.example)')).toEqual([{ type: 'text', text: 'x' }])
  })

  it('autolinks bare https links, leaving trailing punctuation out', () => {
    expect(parseInline('See https://shop.example/a?b=1.')).toEqual([
      { type: 'text', text: 'See ' },
      {
        type: 'link',
        href: 'https://shop.example/a?b=1',
        children: [{ type: 'text', text: 'https://shop.example/a?b=1' }],
      },
      { type: 'text', text: '.' },
    ])
    expect(parseInline('http://plain.example')).toEqual([{ type: 'text', text: 'http://plain.example' }])
  })

  it('leaves HTML as text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { type: 'text', text: '<img src=x onerror=alert(1)>' },
    ])
  })

  it('doesn’t italicise snake_case or lone stars, and honours escapes', () => {
    expect(parseInline('file_name_here')).toEqual([{ type: 'text', text: 'file_name_here' }])
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }])
    expect(parseInline('\\*not em\\*')).toEqual([{ type: 'text', text: '*not em*' }])
  })

  it('turns newlines into line breaks', () => {
    expect(parseInline('a\nb')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'br' },
      { type: 'text', text: 'b' },
    ])
  })

  it('doesn’t put links inside links', () => {
    const [link] = parseInline('[see https://a.example](https://b.example)')
    expect(link).toEqual({
      type: 'link',
      href: 'https://b.example/',
      children: [{ type: 'text', text: 'see https://a.example' }],
    })
  })

  it('stops nesting at a sensible depth', () => {
    const deep = '*'.repeat(40) + 'x' + '*'.repeat(40)
    expect(() => parseInline(deep)).not.toThrow()
  })
})

describe('parseMarkdown', () => {
  it('reads headings, lists, tasks, quotes, code and paragraphs', () => {
    const blocks = parseMarkdown(
      [
        '# Plan',
        '',
        'First line',
        'second line',
        '',
        '- milk',
        '- [x] eggs',
        '- [ ] bread',
        '',
        '1. one',
        '2. two',
        '',
        '> quoted',
        '',
        '```',
        '**not bold**',
        '```',
      ].join('\n'),
    )
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code'])
    expect(blocks[2]).toEqual({
      type: 'list',
      ordered: false,
      items: [
        { checked: null, children: [{ type: 'text', text: 'milk' }] },
        { checked: true, children: [{ type: 'text', text: 'eggs' }] },
        { checked: false, children: [{ type: 'text', text: 'bread' }] },
      ],
    })
    expect(blocks[3]).toMatchObject({ ordered: true })
    expect(blocks[5]).toEqual({ type: 'code', text: '**not bold**' })
    expect(plainText(blocks)).toContain('First line\nsecond line')
  })

  it('handles empty, CRLF and unclosed fences', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('a\r\nb')).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'a' }, { type: 'br' }, { type: 'text', text: 'b' }],
      },
    ])
    expect(parseMarkdown('```\ncode')).toEqual([{ type: 'code', text: 'code' }])
  })
})

describe('linkHostNote', () => {
  it('names the real host when the words point somewhere else', () => {
    expect(linkHostNote('https://evil.example/login', 'https://bank.example')).toBe('evil.example')
    expect(linkHostNote('https://evil.example/', 'bank.example/login')).toBe('evil.example')
    expect(linkHostNote('https://evil.example/', 'www.bank.example')).toBe('evil.example')
  })

  it('always names an international host, which can imitate another', () => {
    expect(linkHostNote('https://xn--pple-43d.example/', 'Apple')).toBe('xn--pple-43d.example')
    expect(linkHostNote('https://аpple.example/', 'Apple')).toMatch(/^xn--/)
  })

  it('stays quiet when the words are plain or match the host', () => {
    expect(linkHostNote('https://plumb.example/x', 'their site')).toBeNull()
    expect(linkHostNote('https://www.bank.example/', 'https://bank.example')).toBeNull()
    expect(linkHostNote('https://bank.example/a', 'BANK.example/b')).toBeNull()
    expect(linkHostNote('not a url', 'x.example')).toBeNull()
  })
})

describe('termination and speed', () => {
  it('treats Unicode line and paragraph separators as line breaks (it used to loop forever)', () => {
    expect(parseMarkdown('# a\u2028b')).toEqual([
      { type: 'heading', level: 1, children: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'b' }] },
    ])
    expect(parseMarkdown('## x\u2029- y').map((b) => b.type)).toEqual(['heading', 'list'])
    expect(parseMarkdown('- a\u0085b').map((b) => b.type)).toEqual(['list', 'paragraph'])
  })

  it('finishes on any mix of awkward characters', () => {
    const alphabet = [
      '#',
      ' ',
      '\n',
      '\u2028',
      '\u2029',
      '\u0085',
      '\r',
      '\t',
      '\v',
      '\f',
      '\u00a0',
      '-',
      '*',
      '_',
      '>',
      '`',
      '[',
      ']',
      '(',
      ')',
      '1',
      '.',
      'x',
      '\\',
      'h',
      'https://a.example',
      '\u202e',
    ]
    let seed = 1
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let n = 0; n < 2000; n++) {
      const length = 1 + Math.floor(next() * 30)
      const text = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')
      const blocks = parseMarkdown(text)
      // Every block takes at least one line.
      expect(blocks.length).toBeLessThanOrEqual(text.split(/\r\n?|[\n\u0085\u2028\u2029]/).length)
    }
  })

  // Compares sizes rather than a fixed time, so a busy machine doesn't fail it: four times the
  // text takes about four times as long if linear, sixteen if quadratic. Notes are cut at
  // MAX_NOTES (20,000 characters), so the sizes can't grow; instead each sample parses the text
  // 20 times, which makes the small run take a few milliseconds, well above the timer's
  // resolution and the 0.5 ms floor. A real slowdown fails every retry; a load spike doesn't.
  it('stays fast on long runs of unclosed marks', { retry: 3 }, () => {
    const REPS = 20
    const time = (unit: string, n: number) => {
      const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
      let best = Infinity
      for (let run = 0; run < 3; run++) {
        const started = performance.now()
        for (let r = 0; r < REPS; r++) parseMarkdown(text)
        best = Math.min(best, performance.now() - started)
      }
      return best
    }
    for (const unit of ['*a ', '_a ', '**a ', '__a ', '`a ', '[a ', 'h ', '[a](b ']) {
      const small = time(unit, 5_000)
      const big = time(unit, MAX_NOTES)
      expect(big / Math.max(small, 0.5), unit).toBeLessThan(9)
      // Each parse of the longest notes allowed stays well under a second.
      expect(big / REPS, unit).toBeLessThan(1_000)
    }
  })
})
