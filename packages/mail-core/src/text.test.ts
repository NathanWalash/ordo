import { describe, expect, it } from 'vitest'
import { bodyText, decodeEntities, htmlToText, printable, tidy } from './text'

describe('decodeEntities', () => {
  it('decodes named and numeric references, and leaves unknown ones', () => {
    expect(decodeEntities('Fish &amp; chips &pound;5 &#8211; &#x1F600; &nosuch;')).toBe(
      'Fish & chips £5 – 😀 &nosuch;',
    )
  })

  it('drops invalid code points', () => {
    expect(decodeEntities('a&#0;b&#xD800;c&#99999999;d')).toBe('abcd')
  })
})

describe('htmlToText', () => {
  it('keeps paragraphs and line breaks, drops styles, scripts and comments', () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
      '<!-- tracking --><script>alert(1)</script><p>Hello&nbsp;there,</p><p>Line one<br>Line two</p>' +
      '<ul><li>One</li><li>Two</li></ul><table><tr><td>A</td><td>B</td></tr></table></body></html>'
    expect(htmlToText(html)).toBe('Hello there,\n\nLine one\nLine two\n\n• One\n• Two\n\nA B')
  })

  it('adds link addresses only when asked and when they differ from the text', () => {
    const html =
      '<a href="https://x.example/a?b=1&amp;c=2">Read more</a> <a href="https://y.example">https://y.example</a>'
    expect(htmlToText(html)).toBe('Read more https://y.example')
    expect(htmlToText(html, { links: true })).toBe(
      'Read more <https://x.example/a?b=1&c=2> https://y.example',
    )
    expect(htmlToText('<a href="javascript:alert(1)">Click</a>', { links: true })).toBe('Click')
  })

  it('takes linear time on unclosed comments, raw-text tags and links', () => {
    for (const opener of ['<!--', '<script>', '<style x>', '<a href="https://x.example">', '<head>']) {
      const html = opener.repeat(Math.ceil(200_000 / opener.length))
      const t = performance.now()
      htmlToText(html, { links: true })
      expect(performance.now() - t, opener).toBeLessThan(500)
    }
  })

  it('drops what follows an unclosed comment, script or tag, and reads at most 256 KB', () => {
    expect(htmlToText('<p>Hi</p><!-- never closed <p>secret</p>')).toBe('Hi')
    expect(htmlToText('<p>Hi</p><script>no end <p>secret</p>')).toBe('Hi')
    expect(htmlToText('<p>Hi</p><img src="x" alt="secret')).toBe('Hi')
    expect(htmlToText('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2')
    const big = `<p>start</p>${'x'.repeat(300 * 1024)}<p>END</p>`
    expect(htmlToText(big)).not.toContain('END')
  })

  it('never returns markup', () => {
    expect(htmlToText('<img src=x onerror=alert(1)><b>bold</b>')).toBe('bold')
  })
})

describe('bodyText and tidy', () => {
  it('prefers the plain text body and falls back to the HTML', () => {
    expect(bodyText({ text: 'Plain\r\n\r\n\r\nText ', html: '<p>Html</p>' })).toBe('Plain\n\nText')
    expect(bodyText({ text: '  ', html: '<p>Html</p>' })).toBe('Html')
    expect(bodyText({ text: null, html: null })).toBe('')
  })

  it('collapses spaces and blank lines', () => {
    expect(tidy('a   b\t c\n\n\n\nd ')).toBe('a b c\n\nd')
  })
})

describe('printable', () => {
  it('removes control characters and bidi overrides but keeps newlines and tabs', () => {
    expect(printable('a\u001b[31mred\u202eb\r\nc\td')).toBe('a[31mredb\nc\td')
  })
})
