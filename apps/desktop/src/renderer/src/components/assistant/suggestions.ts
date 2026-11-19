import type { Route } from '../../routes'

/** `write` and `idea` are general questions, answered from the model's own knowledge. */
export type SuggestionIcon =
  'mail' | 'calendar' | 'money' | 'bills' | 'sparkles' | 'boards' | 'write' | 'idea'

export interface Suggestion {
  text: string
  icon: SuggestionIcon
  /** Ends with "…": put it in the question box to finish, rather than asking it straight away. */
  fill?: true
}

/*
 * Each page mixes questions about the user's own data with general ones (writing, planning,
 * how-tos), so it's clear the assistant does both.
 */
const BY_ROUTE: Record<Route, Suggestion[]> = {
  home: [
    { text: 'What’s on my calendar this week?', icon: 'calendar' },
    { text: 'Which bills are due next?', icon: 'bills' },
    // Planning your own week starts from your calendar: a data question, not a general one.
    { text: 'Help me plan my week', icon: 'calendar' },
    { text: 'Help me word a polite note to my landlord', icon: 'write' },
  ],
  'mail/inbox': [
    { text: 'What’s unread in my inbox?', icon: 'mail' },
    { text: 'Archive this week’s newsletters', icon: 'mail' },
    { text: 'Draft a reply to the last email from …', icon: 'mail', fill: true },
    { text: 'How do I write a polite follow-up?', icon: 'write' },
  ],
  'mail/unclutter': [
    { text: 'Who sends me the most email?', icon: 'mail' },
    { text: 'Which newsletters could I unsubscribe from?', icon: 'mail' },
    { text: 'How can I keep my inbox tidy?', icon: 'idea' },
  ],
  'mail/history': [
    { text: 'What did my last clean-up do?', icon: 'mail' },
    { text: 'Which clean-ups can I still undo?', icon: 'mail' },
    { text: 'What does unsubscribing actually do?', icon: 'idea' },
  ],
  calendar: [
    { text: 'What’s on my calendar this week?', icon: 'calendar' },
    { text: 'When is my next free evening?', icon: 'calendar' },
    { text: 'How can I make a busy week feel calmer?', icon: 'idea' },
  ],
  boards: [
    { text: 'What’s overdue on my boards?', icon: 'boards' },
    { text: 'Add a card to buy milk', icon: 'boards' },
    { text: 'Help me break a big task into steps', icon: 'idea' },
  ],
  'money/finances': [
    { text: 'How much did I spend last month?', icon: 'money' },
    { text: 'What were my biggest payments this month?', icon: 'money' },
    { text: 'How does the 50/30/20 budget work?', icon: 'idea' },
  ],
  'money/bills': [
    { text: 'Which bills are due next?', icon: 'bills' },
    { text: 'How much do my subscriptions cost a month?', icon: 'bills' },
    { text: 'Who owes whom?', icon: 'bills' },
    { text: 'How do I cancel a direct debit?', icon: 'idea' },
  ],
  'money/ask': [
    { text: 'What am I holding for other people?', icon: 'money' },
    { text: 'Who still owes me money?', icon: 'money' },
    { text: 'What questions does Ordo have about my money?', icon: 'money' },
  ],
  settings: [
    { text: 'Which AI model am I using?', icon: 'sparkles' },
    { text: 'What does Ordo know about my account?', icon: 'sparkles' },
    { text: 'What’s the difference between a local and a cloud model?', icon: 'idea' },
  ],
}

/** Prompts to start with, for the page the user is on. */
export function suggestionsFor(route: Route): Suggestion[] {
  return BY_ROUTE[route] ?? BY_ROUTE.home
}
