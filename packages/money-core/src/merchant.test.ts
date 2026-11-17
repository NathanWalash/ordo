import { describe, expect, it } from 'vitest'
import { domainKey, merchantKey, normaliseMerchant, sameMerchant } from './merchant'

describe('normaliseMerchant', () => {
  it.each([
    ['CARD PAYMENT TO NETFLIX.COM ON 03-11-2026', 'Netflix'],
    ['NETFLIX.COM          Amsterdam     NLD', 'Netflix'],
    ['SPOTIFY P2B4C6D8E0 STOCKHOLM SWE', 'Spotify'],
    ['DIRECT DEBIT TO THAMES WATER', 'Thames Water'],
    ['DD SKY DIGITAL', 'Sky Digital'],
    ['CARD PAYMENT TO TFL TRAVEL CH ON 09-09-2026', 'TfL'],
    ['CARD PAYMENT TO WAITROSE 1234 ON 10-09-2026', 'Waitrose'],
    ['AMZNMKTPLACE*AB12CD34', 'Amazon'],
    ['AMAZON PRIME*2K4L67', 'Amazon Prime'],
    ['PAYPAL *SPOTIFY', 'Spotify'],
    ['TESCO STORES 3021 LONDON GBR', 'Tesco Stores'],
    ['CONTACTLESS PAYMENT TO PRET A MANGER 14:22', 'Pret A Manger'],
    ['APPLE.COM/BILL 0800 107 6285 IRL', 'Apple'],
    ['GOOGLE *YouTubePremium g.co/helppay#', 'YouTube Premium'],
    ['DISNEY PLUS', 'Disney+'],
    ['Octopus Energy', 'Octopus Energy'],
    ["Sainsbury's", "Sainsbury's"],
  ])('%s → %s', (raw, name) => {
    expect(normaliseMerchant(raw)).toBe(name)
  })

  it('never returns an empty name', () => {
    expect(normaliseMerchant('12345678')).toBe('12345678')
  })
})

describe('merchant keys', () => {
  it('reduces names to letters and digits', () => {
    expect(merchantKey('Disney+')).toBe('disney')
    expect(merchantKey('Amazon Prime')).toBe('amazonprime')
  })

  it('takes the business name from a domain', () => {
    expect(domainKey('netflix.com')).toBe('netflix')
    expect(domainKey('account.netflix.com')).toBe('netflix')
    expect(domainKey('spotify.co.uk')).toBe('spotify')
    expect(domainKey('email.apple.com')).toBe('apple')
    expect(domainKey('thameswater.co.uk')).toBe('thameswater')
  })

  it('matches equal keys and long-enough prefixes only', () => {
    expect(sameMerchant('netflix', 'netflix')).toBe(true)
    expect(sameMerchant('sky', 'skydigital')).toBe(false)
    expect(sameMerchant('spotify', 'spotifyuk')).toBe(true)
    expect(sameMerchant('', '')).toBe(false)
  })
})
