import { describe, expect, it } from 'vitest'
import { hostRefusal, isBlockedIp, parseIPv6 } from './url-guard'

describe('isBlockedIp', () => {
  it.each([
    ['0.0.0.0', 'this network'],
    ['0.1.2.3', 'this network'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['10.0.0.1', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.254', 'private 172.16/12'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['192.0.2.10', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['::', 'IPv6 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['febf:ffff::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique-local'],
    ['fd12:3456:789a::1', 'IPv6 unique-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['2001:db8::1', 'IPv6 documentation'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata (hex)'],
    ['::ffff:192.168.0.1', 'IPv4-mapped private'],
    ['64:ff9b::a00:1', 'NAT64 of 10.0.0.1'],
    ['2002:c0a8:0101::1', '6to4 of 192.168.1.1'],
    ['fe80::1%en0', 'link-local with zone'],
    ['not-an-ip', 'unparseable'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true)
  })

  it.each(['93.184.215.14', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false)
    },
  )

  it('allows only loopback when the test escape hatch is on', () => {
    expect(isBlockedIp('127.0.0.1', { allowLoopback: true })).toBe(false)
    expect(isBlockedIp('::1', { allowLoopback: true })).toBe(false)
    expect(isBlockedIp('10.0.0.1', { allowLoopback: true })).toBe(true)
    expect(isBlockedIp('169.254.169.254', { allowLoopback: true })).toBe(true)
  })

  it('parses compressed and embedded IPv6 forms', () => {
    expect(parseIPv6('::ffff:1.2.3.4')).toBe(parseIPv6('0:0:0:0:0:ffff:102:304'))
    expect(parseIPv6('[::1]')).toBe(1n)
    expect(parseIPv6('1::2::3')).toBeNull()
  })
})

describe('hostRefusal', () => {
  it.each([
    'https://192.168.1.1/unsub',
    'https://169.254.169.254/latest/meta-data',
    'https://2130706433/u', // decimal 127.0.0.1
    'https://0x7f.1/u', // hex
    'https://0177.0.0.1/u', // octal
    'https://10.1/u', // short form
    'https://[::1]/u',
    'https://[::ffff:7f00:1]/u',
    'https://[fe80::1]/u',
  ])('refuses the IP literal in %s', (url) => {
    expect(hostRefusal(url)).toMatch(/IP number/)
  })

  it.each(['https://router/u', 'https://localhost/u', 'https://intranet./u', 'https://app.localhost/u'])(
    'refuses the local name in %s',
    (url) => {
      expect(hostRefusal(url)).toMatch(/local network name/)
    },
  )

  it('accepts public domain names', () => {
    expect(hostRefusal('https://list.example.com/u?id=1')).toBeNull()
  })

  it('lets loopback through only with the test escape hatch', () => {
    expect(hostRefusal('http://127.0.0.1:4000/u', { allowLoopback: true })).toBeNull()
    expect(hostRefusal('http://localhost:4000/u', { allowLoopback: true })).toBeNull()
    expect(hostRefusal('https://192.168.1.1/u', { allowLoopback: true })).not.toBeNull()
  })
})
