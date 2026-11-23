import { describe, expect, it, vi } from 'vitest'
import { checkEndpoints, googleFetch, GoogleHostError, isConsentUrl } from './fetch'
import { endpointsAt, GOOGLE_ENDPOINTS } from './oauth'

describe('the Google allow-list', () => {
  it('lets a packaged build use Google’s own endpoints only', () => {
    expect(() => checkEndpoints(GOOGLE_ENDPOINTS, { packaged: true })).not.toThrow()
    expect(() => checkEndpoints(endpointsAt('http://127.0.0.1:9999'), { packaged: true })).toThrow(
      GoogleHostError,
    )
    expect(() =>
      checkEndpoints({ ...GOOGLE_ENDPOINTS, api: 'https://evil.example' }, { packaged: true }),
    ).toThrow()
  })

  it('lets a development build use a loopback fake, and nothing else', () => {
    expect(() => checkEndpoints(endpointsAt('http://127.0.0.1:9999'), { packaged: false })).not.toThrow()
    expect(() => checkEndpoints(endpointsAt('https://google.evil.example'), { packaged: false })).toThrow()
  })

  it('fetches only from the token, revoke and API origins, over https, without redirects', async () => {
    const base = vi.fn(async () => new Response('{}'))
    const f = googleFetch(GOOGLE_ENDPOINTS, base)
    await f('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      method: 'GET',
      redirect: 'follow',
    })
    await f('https://oauth2.googleapis.com/token', { method: 'POST' })
    expect(base.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1].redirect)).toEqual([
      'error',
      'error',
    ])
    for (const bad of [
      'https://evil.example/token',
      'https://accounts.google.com/o/oauth2/v2/auth',
      'http://www.googleapis.com/calendar/v3/x',
      'https://www.googleapis.com.evil.example/x',
    ])
      await expect(f(bad, {})).rejects.toBeInstanceOf(GoogleHostError)
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('allows plain http only to a loopback fake', async () => {
    const base = vi.fn(async () => new Response('{}'))
    const f = googleFetch(endpointsAt('http://127.0.0.1:4000'), base)
    await f('http://127.0.0.1:4000/token', {})
    await expect(f('http://127.0.0.1:4001/token', {})).rejects.toBeInstanceOf(GoogleHostError)
  })

  it('opens only the consent page in the browser', () => {
    expect(isConsentUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', GOOGLE_ENDPOINTS)).toBe(
      true,
    )
    expect(isConsentUrl('https://accounts.google.com.evil.example/o/oauth2/v2/auth', GOOGLE_ENDPOINTS)).toBe(
      false,
    )
    expect(isConsentUrl('https://user:pw@accounts.google.com/o/oauth2/v2/auth', GOOGLE_ENDPOINTS)).toBe(false)
    expect(isConsentUrl('https://accounts.google.com/other', GOOGLE_ENDPOINTS)).toBe(false)
    expect(isConsentUrl('javascript:alert(1)', GOOGLE_ENDPOINTS)).toBe(false)
  })
})
