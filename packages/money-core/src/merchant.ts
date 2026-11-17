// Turn raw statement descriptions into merchant names people recognise.

const PREFIXES = [
  /^card payment( to)?\b/,
  /^contactless( payment)?( to)?\b/,
  /^debit card payment( to)?\b/,
  /^card purchase\b/,
  /^direct debit( payment)?( to)?\b/,
  /^standing order( to)?\b/,
  /^bill payment( to)?\b/,
  /^faster payments?( to| from)?\b/,
  /^payment( to| from)\b/,
  /^(pos|visa|vis|dd|so|bp|fpo|fpi|bgc|deb|cpt|chq|tfr|dr|cr)\b/,
  /^(paypal|pp|sq|sumup|iz|zettle_|sp|tst|crv|lsp)\s*\*/,
]

/** Known messy names → what people call them. Checked against the cleaned, lower-case text. */
const ALIASES: [RegExp, string][] = [
  [/^(amzn|amazon)\s*(prime|prime\s*video|digital)\b|^prime video\b/, 'Amazon Prime'],
  [/^(amzn\s*mktp|amznmktplace|amazon\s*(co\s*uk|com|marketplace|mktplace|retail))|^amazon\b/, 'Amazon'],
  [/^apple\s*com\s*bill|^apple\s*(services|bill)|^itunes/, 'Apple'],
  [/^google\s*(youtube|youtubepremium)|^youtube\s*premium/, 'YouTube Premium'],
  [/^google\s*(storage|one)/, 'Google One'],
  [/^netflix/, 'Netflix'],
  [/^spotify/, 'Spotify'],
  [/^disney\s*(plus|\+)?/, 'Disney+'],
  [/^tfl\b|^transport for london/, 'TfL'],
  [/^uber\s*eats/, 'Uber Eats'],
  [/^deliveroo/, 'Deliveroo'],
  [/^now\s*tv|^nowtv/, 'NOW'],
  [/^tv licen[cs]e|^tvl\b/, 'TV Licence'],
  [/^pure\s*gym/, 'PureGym'],
  [/^audible/, 'Audible'],
]

const COUNTRY = /\s+(gb|gbr|uk|us|usa|ie|irl|nl|nld|lu|lux|de|deu|fr|fra|se|swe|ca|au)$/
const CITIES =
  /\s+(london|manchester|birmingham|leeds|glasgow|edinburgh|bristol|liverpool|cardiff|dublin|amsterdam|luxembourg|stockholm|los gatos|cupertino|cork)$/

/** Strip the noise from a statement description and return a display name, e.g. `Netflix`. */
export function normaliseMerchant(description: string): string {
  let s = ` ${description.toLowerCase()} `
    // dates and times: 03-11-2026, 03/11, 3 nov, 14:22, on 03 nov
    .replace(/\s(on|at)\s+\d{1,2}[\s/.-]*([a-z]{3}|\d{1,2})([\s/.-]*\d{2,4})?(?=\s)/g, ' ')
    .replace(/\s\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?(?=\s)/g, ' ')
    .replace(/\s\d{1,2}\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s?\d{2,4})?(?=\s)/g, ' ')
    .replace(/\s\d{1,2}:\d{2}(:\d{2})?(?=\s)/g, ' ')
    .trim()

  for (let changed = true; changed;) {
    changed = false
    for (const p of PREFIXES) {
      const next = s.replace(p, '').trim()
      if (next !== s && next) {
        s = next
        changed = true
      }
    }
  }

  // `GOOGLE *YouTube`: the part after the star is the actual service.
  s = s.replace(/^(google|apple)\s*\*\s*/, '$1 ')

  s = s
    // card numbers and references: *1234, x1234, cd 1234, ref: abc123
    .replace(/\b(cd|card|ref|reference|mandate|no|nº)[:.]?\s*[\w-]*\d[\w-]*/g, ' ')
    .replace(/[*#]\s*\w*/g, ' ')
    // phone numbers and long digit runs
    .replace(/\+?\d[\d\s-]{6,}\d/g, ' ')
    // tokens mixing letters and digits (P1A2B3C4D5), and bare numbers
    .replace(/\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]{5,}\b/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    // web addresses: netflix.com → netflix, www.
    .replace(/\bwww\./g, '')
    .replace(/\.(com|co\.uk|org\.uk|net|org|io|uk|tv|co)\b/g, ' ')
    .replace(/[^a-z&+'\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  for (let i = 0; i < 3; i++) s = s.replace(COUNTRY, '').replace(CITIES, '').trim()
  s = s.replace(/[\s.-]+$/, '').replace(/^[\s.-]+/, '')

  for (const [re, name] of ALIASES) if (re.test(s)) return name
  if (!s) return description.trim()
  return s.replace(/(^|[\s-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase())
}

/** Lower-case letters and digits only: `Disney+` → `disney`, `Amazon Prime` → `amazonprime`. */
export function merchantKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const SUFFIXES = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'ltd', 'plc', 'me', 'sch', 'nhs'])

/** The name part of a domain: `email.netflix.com` → `netflix`, `spotify.co.uk` → `spotify`. */
export function domainKey(domain: string): string {
  const labels = domain.toLowerCase().split('.').filter(Boolean)
  labels.pop() // top-level domain
  while (labels.length > 1 && SUFFIXES.has(labels[labels.length - 1]!)) labels.pop()
  return merchantKey(labels[labels.length - 1] ?? '')
}

/**
 * Do two merchant keys name the same business? Equal, or one starts with the other
 * and the shorter is long enough not to be a coincidence (`netflix` / `netflixcom`).
 */
export function sameMerchant(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 4 && long.startsWith(short)
}
