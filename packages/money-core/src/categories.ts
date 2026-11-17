// Cheap, explainable spending categories. The bank's own category wins when the CSV has one.

export const SPENDING_CATEGORIES = [
  'Groceries',
  'Eating out',
  'Transport',
  'Bills',
  'Subscriptions',
  'Shopping',
  'Entertainment',
  'Health',
  'Cash',
  'Transfers',
  'Income',
  'Other',
] as const

const RULES: [string, RegExp][] = [
  ['Transfers', /\b(transfer|tfr|to savings|from savings|savings pot|pot transfer|isa|revolut|monzo pot)\b/],
  ['Cash', /\b(atm|cash withdrawal|cashpoint|link atm)\b/],
  [
    'Subscriptions',
    /\b(netflix|spotify|disney|apple|itunes|youtube|amazon prime|prime video|now tv|nowtv|audible|icloud|google one|google storage|patreon|chatgpt|openai|adobe|microsoft 365|dropbox|deezer|tidal|paramount|crunchyroll)\b/,
  ],
  [
    'Bills',
    /\b(rent|council tax|water|thames|severn trent|anglian|united utilities|energy|octopus|british gas|edf|ovo|e\.?on|scottish power|bulb|electric|gas|broadband|bt group|bt\b|virgin media|sky|ee limited|ee\b|vodafone|three|o2|giffgaff|tv licen[cs]e|insurance|mortgage)\b/,
  ],
  [
    'Groceries',
    /\b(tesco|sainsbury|asda|aldi|lidl|waitrose|morrisons|co-?op|ocado|iceland|m&s food|marks & spencer food|farmfoods|spar|budgens|whole foods)\b/,
  ],
  [
    'Eating out',
    /\b(pret|deliveroo|uber eats|just eat|nando|mcdonald|starbucks|costa|caffe nero|greggs|kfc|burger king|wagamama|pizza|restaurant|cafe|coffee|bar|pub|dishoom|leon|itsu|wasabi)\b/,
  ],
  [
    'Transport',
    /\b(tfl|uber|bolt|trainline|lner|gwr|avanti|national rail|southern|thameslink|northern|shell|bp|esso|texaco|parking|ringgo|citymapper|easyjet|ryanair|british airways)\b/,
  ],
  ['Health', /\b(pharmacy|boots|superdrug|gym|puregym|the gym|dentist|optician|nhs|bupa)\b/],
  ['Entertainment', /\b(cinema|odeon|vue|everyman|ticketmaster|steam|playstation|xbox|nintendo|theatre)\b/],
  [
    'Shopping',
    /\b(amazon|amzn|ebay|argos|john lewis|asos|ikea|zara|h&m|uniqlo|primark|currys|next|boots|etsy|vinted)\b/,
  ],
]

/** Pick a category from the merchant and description. Money in counts as Income unless it's a transfer. */
export function categorise(description: string, merchant: string, amount: number): string {
  const text = `${merchant} ${description}`.toLowerCase()
  for (const [name, re] of RULES) {
    if (name === 'Transfers' && re.test(text)) return name
    if (amount > 0) continue
    if (re.test(text)) return name
  }
  return amount > 0 ? 'Income' : 'Other'
}

/** Tidy a bank-supplied category: `EATING_OUT` or `eating_out` → `Eating out`. */
export function tidyCategory(raw: string): string | undefined {
  const s = raw.trim().replace(/[_-]+/g, ' ').toLowerCase()
  if (!s) return undefined
  if (s === 'general') return undefined
  return s.charAt(0).toUpperCase() + s.slice(1)
}
