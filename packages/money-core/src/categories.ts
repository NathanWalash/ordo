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
  'Fees',
  'Other',
] as const

const BASE_RULES: [string, RegExp][] = [
  ['Transfers', /\b(transfer|tfr|to savings|from savings|savings pot|pot transfer|isa|revolut|monzo pot)\b/],
  ['Cash', /\b(atm|cash withdrawal|cashpoint|link atm)\b/],
  [
    'Subscriptions',
    /\b(netflix|spotify|disney|apple|itunes|youtube|amazon prime|prime video|now tv|nowtv|audible|icloud|google one|google storage|patreon|chatgpt|openai|adobe|microsoft 365|dropbox|deezer|tidal|paramount|crunchyroll)\b/,
  ],
  [
    'Bills',
    /\b(rent|council tax|city council|water|thames|severn trent|anglian|united utilities|energy|octopus|british gas|edf|ovo|e\.?on|scottish power|bulb|electric|gas|broadband|bt group|bt\b|virgin media|sky|ee limited|ee\b|vodafone|three|o2|giffgaff|tv licen[cs]e|insurance|mortgage)\b/,
  ],
  [
    'Groceries',
    /\b(tesco|sainsbury|asda|aldi|lidl|waitrose|morrisons|co-?op|ocado|iceland|m&s food|marks & spencer food|farmfoods|spar|budgens|whole foods|one stop|home bargains|b&m|costcutter|nisa|premier stores|londis|heron foods)\b/,
  ],
  [
    'Eating out',
    /\b(pret|deliveroo|uber eats|just eat|nando|mcdonald|starbucks|costa|caffe nero|greggs|kfc|burger king|wagamama|pizza|restaurant|cafe|coffee|bar|pub|dishoom|leon|itsu|wasabi|wetherspoon|greene king|popeyes|taco bell|subway|five guys|gail's|gails|pizza express|franco manca|honest burgers|chick 'n' bao)\b/,
  ],
  [
    'Transport',
    /\b(tfl|uber|bolt|trainline|lner|gwr|avanti|national rail|southern|thameslink|northern|shell|bp|esso|texaco|parking|ringgo|citymapper|easyjet|ryanair|british airways|first bus|first west|stagecoach|arriva|national express|megabus|beryl|voi|lime\*?\s?ride|santander cycles|zipcar)\b/,
  ],
  [
    'Health',
    /\b(pharmacy|boots|superdrug|gym|puregym|the gym|dentist|optician|nhs|bupa|the gym group|the gym ltd|gym group|nuffield|specsavers)\b/,
  ],
  [
    'Entertainment',
    /\b(cinema|odeon|vue|everyman|ticketmaster|steam|playstation|xbox|nintendo|theatre|fixr|resident advisor|dice|skiddle|eventbrite|see tickets|regal|cineworld|picturehouse)\b/,
  ],
  [
    'Shopping',
    /\b(amazon|amzn|ebay|argos|john lewis|asos|ikea|zara|h&m|uniqlo|primark|currys|next|boots|etsy|vinted|tk ?maxx|tkmaxx|jd sports|depop|sports direct|matalan|wilko|the works|waterstones|whsmith|smiggle)\b/,
  ],
]

/**
 * Statements write names like `SAINSBURYS`, `MCDONALDS` or `SAINSBURY'S`: let every keyword
 * also match with a trailing `s` or `'s`.
 */
const RULES: [string, RegExp][] = BASE_RULES.map(([name, re]) => [
  name,
  new RegExp(re.source.replace(/\)\\b$/, ")(?:'?s)?\\b"), re.flags),
])

const FEES =
  /\b(non-sterling transaction fee|foreign (transaction|exchange) fee|transaction fee|overdraft fee|monthly fee)\b/
/** A direct debit or standing order (HSBC's `DD` and `SO` codes) that no rule placed is most likely a bill. */
const REGULAR_PAYMENT = /\s(dd|so)$|\b(direct debit|standing order)\b/
const NOT_BILLS = /\b(paypal|pp)\b/

/** Pick a category from the merchant and description. Money in counts as Income unless it's a transfer. */
/** HSBC's transaction code at the end of a description (`BP`, `DD`, `)))`...) isn't part of the name. */
const BANK_CODE = /\s(\)\)\)|vis|dd|so|bp|obp|cr|dr|atm)$/

export function categorise(description: string, merchant: string, amount: number): string {
  const text = `${merchant} ${description.toLowerCase().replace(BANK_CODE, '')}`.toLowerCase()
  if (amount < 0 && FEES.test(text)) return 'Fees'
  for (const [name, re] of RULES) {
    if (name === 'Transfers' && re.test(text)) return name
    if (amount > 0) continue
    if (re.test(text)) return name
  }
  if (amount < 0 && REGULAR_PAYMENT.test(description.toLowerCase()) && !NOT_BILLS.test(text)) return 'Bills'
  return amount > 0 ? 'Income' : 'Other'
}

/** Tidy a bank-supplied category: `EATING_OUT` or `eating_out` → `Eating out`. */
export function tidyCategory(raw: string): string | undefined {
  const s = raw.trim().replace(/[_-]+/g, ' ').toLowerCase()
  if (!s) return undefined
  if (s === 'general') return undefined
  return s.charAt(0).toUpperCase() + s.slice(1)
}
