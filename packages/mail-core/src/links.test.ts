import { describe, expect, it } from 'vitest'
import { checkLink } from './links'

describe('checkLink', () => {
  it('opens web links and says whether they are secure', () => {
    expect(checkLink('https://shop.example/sale', 'See the sale')).toEqual({
      kind: 'web',
      url: 'https://shop.example/sale',
      host: 'shop.example',
      secure: true,
      mismatch: null,
    })
    expect(checkLink('http://shop.example/')).toMatchObject({ kind: 'web', secure: false })
  })

  it('warns when the text names another site', () => {
    expect(checkLink('https://evil.example/login', 'www.mybank.co.uk')).toMatchObject({
      kind: 'web',
      mismatch: { shown: 'mybank.co.uk', actual: 'evil.example' },
    })
    expect(checkLink('https://track.mybank.co.uk/x', 'https://www.mybank.co.uk')).toMatchObject({
      mismatch: null,
    })
    // Not a real domain: no warning.
    expect(checkLink('https://files.example/r', 'report.pdf')).toMatchObject({ mismatch: null })
  })

  it('hands mailto: links to the composer', () => {
    expect(checkLink(' mailto:a@x.example ')).toEqual({ kind: 'mailto', url: 'mailto:a@x.example' })
  })

  it('refuses other schemes, user names in the address, junk and very long links', () => {
    expect(checkLink('javascript:alert(1)')).toMatchObject({ kind: 'refused' })
    expect(checkLink('file:///etc/passwd')).toMatchObject({ kind: 'refused' })
    expect(checkLink('x-apple-systempreferences:com.apple')).toMatchObject({ kind: 'refused' })
    expect(checkLink('https://mybank.example@evil.example/')).toMatchObject({ kind: 'refused' })
    expect(checkLink('not a url')).toMatchObject({ kind: 'refused' })
    expect(checkLink(`https://x.example/${'a'.repeat(5000)}`)).toMatchObject({ kind: 'refused' })
  })
})
