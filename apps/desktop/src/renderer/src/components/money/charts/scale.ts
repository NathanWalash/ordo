// Pure helpers for the Finances charts: tidy axis ticks, short money and month labels, and which
// months fit on screen.

export interface Ticks {
  lo: number
  hi: number
  ticks: number[]
}

/** A step of 1, 2, 2.5 or 5 × 10ⁿ that splits `span` into about `count` parts. */
function niceStep(span: number, count: number): number {
  const raw = span / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const f = raw / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow
}

/**
 * Round ticks covering `min`..`max` (pence), always including zero. With nothing to show the axis
 * runs from £0 to £10, so an empty chart still has a sensible frame.
 */
export function niceTicks(min: number, max: number, count = 4): Ticks {
  const lo0 = Math.min(0, min)
  const hi0 = Math.max(0, max)
  if (hi0 === lo0) return { lo: 0, hi: 1000, ticks: [0, 500, 1000] }
  const step = Math.max(100, niceStep(hi0 - lo0, count))
  const lo = Math.floor(lo0 / step) * step
  const hi = Math.ceil(hi0 / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v))
  return { lo, hi, ticks }
}

/** `£0`, `£450`, `£1.5k`, `£12k`, `£1.2m`, with a real minus sign for negatives. Whole pounds only. */
export function formatAxisPence(pence: number): string {
  const sign = pence < 0 ? '−' : ''
  const pounds = Math.abs(pence) / 100
  const short = (n: number) => String(Math.round(n * 10) / 10)
  if (pounds >= 1_000_000) return `${sign}£${short(pounds / 1_000_000)}m`
  if (pounds >= 1000) return `${sign}£${short(pounds / 1000)}k`
  return `${sign}£${Math.round(pounds)}`
}

const shortFmt = new Intl.DateTimeFormat('en-GB', { month: 'short' })
const yearFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' })

/** `Nov` for `2026-11`, or `Jan 27` with `withYear`. */
export function shortMonth(ym: string, withYear = false): string {
  return (withYear ? yearFmt : shortFmt).format(new Date(`${ym}-01T00:00:00`))
}

/**
 * The months to draw, as `[start, end)`: the latest `size`, or a run ending at `selected` when the
 * chosen month is older than that.
 */
export function visibleRange(count: number, selected: number, size = 24): [number, number] {
  if (count <= size) return [0, count]
  const end = selected >= 0 && selected < count - size ? Math.max(size, selected + 1) : count
  return [end - size, end]
}

/** Label every `n`th column so labels about `minGap` pixels wide never overlap. */
export function labelEvery(columns: number, plotWidth: number, minGap = 44): number {
  if (columns <= 0) return 1
  const fit = Math.max(1, Math.floor(plotWidth / minGap))
  return Math.max(1, Math.ceil(columns / fit))
}

/** A bar from `base` to `end` (pixels on y), `r`-rounded at the data end and square at the base. */
export function barPath(x: number, width: number, base: number, end: number, radius = 4): string {
  const h = Math.abs(end - base)
  if (h < 0.5 || width <= 0) return ''
  const r = Math.min(radius, h, width / 2)
  const tip = end < base ? end + r : end - r
  const right = x + width
  return `M${x},${base}V${tip}Q${x},${end} ${x + r},${end}H${right - r}Q${right},${end} ${right},${tip}V${base}Z`
}
