export const ROUTES = [
  'home',
  'mail/inbox',
  'mail/unclutter',
  'mail/history',
  'calendar',
  'boards',
  'money/finances',
  'money/bills',
  'settings',
] as const
export type Route = (typeof ROUTES)[number]

export const TITLES: Record<Route, string> = {
  home: 'Home',
  'mail/inbox': 'Inbox',
  'mail/unclutter': 'Unclutter',
  'mail/history': 'Clean-up history',
  calendar: 'Calendar',
  boards: 'Boards',
  'money/finances': 'Finances',
  'money/bills': 'Bills & Subscriptions',
  settings: 'Settings',
}

/**
 * Routes live in the URL hash (`#/mail/inbox`) so the app can open on any screen. A page may
 * read options after a `?`, like `#/boards?card=…`.
 */
export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0]!
  return (ROUTES as readonly string[]).includes(path) ? (path as Route) : 'home'
}
