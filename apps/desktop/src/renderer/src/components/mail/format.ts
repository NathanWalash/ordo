import { displayName, type Address } from '@ordo/mail-core'

const DAY = 86_400_000

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** A date for the message list: the time today, "Yesterday", the weekday this week, else the date. */
export function listDate(d: Date, now = new Date()): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / DAY)
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' })
}

/** A date in full, for the reading pane and quoted replies. */
export const fullDate = (d: Date) => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Up to two initials for an avatar. */
export function initials(a: Address | null | undefined): string {
  const name = displayName(a)
  const words = name
    .replace(/<.*?>|["']/g, '')
    .split(/[\s@._-]+/)
    .filter(Boolean)
  const letters = words.length > 1 ? [words[0]![0], words[1]![0]] : [name[0]]
  return letters.join('').toUpperCase() || '?'
}

export const people = (list: readonly Address[]) => list.map((a) => displayName(a)).join(', ')

/** A file size people can read: 980 bytes, 12 KB, 3.4 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** Attachments are base64 on the server, a third bigger than the file. */
export const decodedSize = (encoded: number) => Math.round((encoded * 3) / 4)
