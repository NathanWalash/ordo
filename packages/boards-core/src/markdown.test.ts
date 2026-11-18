import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, plainText } from './markdown'

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

  it('stays fast on long runs of unclosed marks', () => {
    for (const unit of ['*a ', '_a ', '**a ', '__a ', '`a ', '[a ', 'h ', '[a](b ']) {
      const text = unit.repeat(Math.ceil(20_000 / unit.length)).slice(0, 20_000)
      const started = performance.now()
      parseMarkdown(text)
      expect(performance.now() - started, unit).toBeLessThan(250)
    }
  })
})
