import type { ISODate } from './types'

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar day written `YYYY-MM-DD` (so not 2026-02-30). */
export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false
  const m = ISO.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The local day of `d` (today by default) as `YYYY-MM-DD`. */
export function toISODate(d: Date = new Date()): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight of a day. */
export function fromISODate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

export function addDays(iso: ISODate, days: number): ISODate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: ISODate, b: ISODate): number {
  const t = (iso: ISODate) => {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((t(b) - t(a)) / 86_400_000)
}
