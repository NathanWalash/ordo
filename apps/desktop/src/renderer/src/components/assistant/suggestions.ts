import type { Route } from '../../routes'

export type SuggestionIcon = 'mail' | 'calendar' | 'money' | 'bills' | 'sparkles' | 'boards'

export interface Suggestion {
  text: string
  icon: SuggestionIcon
}

const MAIL: Suggestion[] = [
  { text: 'Who sends me the most email?', icon: 'mail' },
  { text: 'Which newsletters could I unsubscribe from?', icon: 'mail' },
  { text: 'What did my last clean-up do?', icon: 'mail' },
]

const BY_ROUTE: Record<Route, Suggestion[]> = {
  home: [
    { text: 'What’s on my calendar this week?', icon: 'calendar' },
    { text: 'Which bills are due next?', icon: 'bills' },
    { text: 'How much did I spend last month?', icon: 'money' },
  ],
  'mail/inbox': MAIL,
  'mail/unclutter': MAIL,
  'mail/history': [
    { text: 'What did my last clean-up do?', icon: 'mail' },
    { text: 'Which clean-ups can I still undo?', icon: 'mail' },
  ],
  calendar: [
    { text: 'What’s on my calendar this week?', icon: 'calendar' },
    { text: 'What have I got tomorrow?', icon: 'calendar' },
    { text: 'When is my next free evening?', icon: 'calendar' },
  ],
  boards: [
    { text: 'What’s overdue on my boards?', icon: 'boards' },
    { text: 'What’s in progress?', icon: 'boards' },
    { text: 'Add a card to buy milk', icon: 'boards' },
  ],
  'money/finances': [
    { text: 'How much did I spend last month?', icon: 'money' },
    { text: 'What were my biggest payments this month?', icon: 'money' },
    { text: 'Show me last month’s spending', icon: 'money' },
  ],
  'money/bills': [
    { text: 'Which bills are due next?', icon: 'bills' },
    { text: 'How much do my subscriptions cost a month?', icon: 'bills' },
    { text: 'Who owes whom?', icon: 'bills' },
  ],
  settings: [
    { text: 'Which AI model am I using?', icon: 'sparkles' },
    { text: 'What does Ordo know about my account?', icon: 'sparkles' },
  ],
}

/** Prompts to start with, for the page the user is on. */
export function suggestionsFor(route: Route): Suggestion[] {
  return BY_ROUTE[route] ?? BY_ROUTE.home
}
