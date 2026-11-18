import { isISODate } from './dates'
import type { FieldDef, FieldType, FieldValue } from './types'

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Choice',
  checkbox: 'Checkbox',
  url: 'Link',
  person: 'Person',
}

export const MAX_TEXT_FIELD = 500
export const MAX_URL_FIELD = 2000
export const MAX_PERSON_FIELD = 80

export type FieldCheck = { ok: true; value: FieldValue | null } | { ok: false; message: string }

const ok = (value: FieldValue | null): FieldCheck => ({ ok: true, value })
const bad = (message: string): FieldCheck => ({ ok: false, message })

/**
 * Only https web links: a link may be opened in the browser (Ordo only ever opens https), so
 * nothing else gets in. No user names or passwords in the link either.
 */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Check a value for a custom field and put it in its stored form. `null` (and an empty string,
 * or an unticked checkbox) clears the field.
 */
export function normaliseFieldValue(
  def: Pick<FieldDef, 'type' | 'options' | 'name'>,
  raw: unknown,
): FieldCheck {
  if (raw === null || raw === undefined) return ok(null)
  const text = typeof raw === 'string' ? raw.trim() : null
  if (text === '') return ok(null)
  switch (def.type) {
    case 'text':
      if (text === null) return bad(`${def.name} needs text.`)
      return text.length > MAX_TEXT_FIELD ? bad(`${def.name} is too long.`) : ok(text)
    case 'person':
      if (text === null) return bad(`${def.name} needs a name.`)
      return text.length > MAX_PERSON_FIELD ? bad(`${def.name} is too long.`) : ok(text)
    case 'number': {
      const n =
        typeof raw === 'number' ? raw : text !== null && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) return bad(`${def.name} needs a number.`)
      return ok(n)
    }
    case 'date':
      return text !== null && isISODate(text) ? ok(text) : bad(`${def.name} needs a date.`)
    case 'select': {
      if (text === null) return bad(`Choose an option for ${def.name}.`)
      const option = def.options.find((o) => o.id === text || o.name.toLowerCase() === text.toLowerCase())
      return option ? ok(option.id) : bad(`Choose an option for ${def.name}.`)
    }
    case 'checkbox':
      if (typeof raw === 'boolean') return ok(raw ? true : null)
      if (text === 'true' || text === 'yes') return ok(true)
      if (text === 'false' || text === 'no') return ok(null)
      return bad(`${def.name} is yes or no.`)
    case 'url': {
      if (text === null || text.length > MAX_URL_FIELD) return bad(`${def.name} needs a web link.`)
      const url = safeUrl(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
      return url ? ok(url) : bad(`${def.name} needs a web link starting with https://.`)
    }
  }
}

/** A field value as text, for search, headless output and the AI prompt. */
export function fieldText(def: Pick<FieldDef, 'type' | 'options'>, value: FieldValue | undefined): string {
  if (value === undefined) return ''
  if (def.type === 'select') return def.options.find((o) => o.id === value)?.name ?? ''
  if (def.type === 'checkbox') return value === true ? 'Yes' : ''
  return String(value)
}
