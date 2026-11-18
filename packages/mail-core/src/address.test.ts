import { describe, expect, it } from 'vitest'
import {
  displayName,
  formatAddress,
  formatAddressList,
  isEmailAddress,
  parseAddress,
  parseAddressList,
  personLabel,
} from './address'

describe('parseAddressList', () => {
  it('reads plain addresses, names and quoted names with commas', () => {
    expect(
      parseAddressList('sam@friend.example, Pat Lee <pat@friend.example>; "Doe, Jo" <jo@x.example>'),
    ).toEqual({
      addresses: [
        { address: 'sam@friend.example' },
        { address: 'pat@friend.example', name: 'Pat Lee' },
        { address: 'jo@x.example', name: 'Doe, Jo' },
      ],
      invalid: [],
    })
  })

  it('reports what isn’t an address and drops duplicates ignoring case', () => {
    expect(parseAddressList('sam@friend.example, nope, SAM@friend.example, a@b, , x@y.example')).toEqual({
      addresses: [{ address: 'sam@friend.example' }, { address: 'x@y.example' }],
      invalid: ['nope', 'a@b'],
    })
  })

  it('refuses header injection and over-long names', () => {
    expect(parseAddress('a@x.example\r\nBcc: spy@z.example')).toBeNull()
    expect(parseAddress(`${'n'.repeat(101)} <a@x.example>`)).toBeNull()
    expect(parseAddress('mailto:a@x.example')).toEqual({ address: 'a@x.example' })
    expect(parseAddress('a@x.example <a@x.example>')).toEqual({ address: 'a@x.example' })
  })

  it('checks address shape and length', () => {
    expect(isEmailAddress('a.b+tag@mail.x.example')).toBe(true)
    expect(isEmailAddress('a@b')).toBe(false)
    expect(isEmailAddress(`${'a'.repeat(250)}@x.example`)).toBe(false)
  })
})

describe('formatAddress', () => {
  it('quotes names that need it', () => {
    expect(formatAddress({ address: 'a@x.example' })).toBe('a@x.example')
    expect(formatAddress({ address: 'a@x.example', name: 'Pat' })).toBe('Pat <a@x.example>')
    expect(formatAddress({ address: 'a@x.example', name: 'Doe, "Jo"' })).toBe('"Doe, \\"Jo\\"" <a@x.example>')
    expect(formatAddressList([{ address: 'a@x.example' }, { address: 'b@x.example', name: 'B' }])).toBe(
      'a@x.example, B <b@x.example>',
    )
  })

  it('round-trips through the parser', () => {
    const list = [{ address: 'jo@x.example', name: 'Doe, "Jo"' }]
    expect(parseAddressList(formatAddressList(list)).addresses).toEqual(list)
  })

  it('shows a name or the address', () => {
    expect(displayName({ address: 'a@x.example', name: ' ' })).toBe('a@x.example')
    expect(displayName(null)).toBe('')
  })

  it('never lets a name that looks like an address stand in for a different one', () => {
    expect(displayName({ address: 'attacker@evil.example', name: 'boss@company.example' })).toBe(
      'attacker@evil.example',
    )
    expect(displayName({ address: 'boss@company.example', name: 'BOSS@company.example' })).toBe(
      'BOSS@company.example',
    )
    expect(personLabel({ address: 'attacker@evil.example', name: 'Boss' })).toBe(
      'Boss <attacker@evil.example>',
    )
    expect(personLabel({ address: 'a@x.example' })).toBe('a@x.example')
  })
})
