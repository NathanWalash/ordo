import { describe, expect, it } from 'vitest'
import { isAbsoluteLocalPath, isUncOrDevicePath, pathProblem } from './paths'

describe('paths from outside Ordo', () => {
  it.each([
    '\\\\server\\share\\a.csv',
    '//server/share/a.csv',
    '\\\\?\\C:\\a.csv',
    '\\\\.\\pipe\\x',
    '/\\host\\a.csv',
    '  \\\\server\\a.csv',
  ])('rejects the UNC or device path %s', (p) => {
    expect(isUncOrDevicePath(p)).toBe(true)
    expect(isAbsoluteLocalPath(p)).toBe(false)
    expect(pathProblem(p, { requireAbsolute: false })).toMatch(/not network or device paths/)
  })

  it.each(['/Users/me/statement.csv', 'C:\\Users\\me\\statement.csv', 'd:/x.csv'])(
    'accepts the local path %s',
    (p) => {
      expect(isAbsoluteLocalPath(p)).toBe(true)
      expect(pathProblem(p, { requireAbsolute: true })).toBeNull()
    },
  )

  it('needs an absolute path only when asked', () => {
    expect(pathProblem('statement.csv', { requireAbsolute: false })).toBeNull()
    expect(pathProblem('statement.csv', { requireAbsolute: true })).toMatch(/full path/)
    expect(pathProblem('~/statement.csv', { requireAbsolute: true })).toMatch(/full path/)
    expect(pathProblem('file:///etc/passwd', { requireAbsolute: true })).toMatch(/full path/)
  })

  it('rejects control characters', () => {
    expect(pathProblem('/tmp/a\u0000.csv', { requireAbsolute: true })).toMatch(/control characters/)
  })
})
