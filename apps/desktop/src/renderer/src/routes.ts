export const ROUTES = [
  'home',
  'mail/inbox',
  'mail/unclutter',
  'mail/history',
  'calendar',
  'finance',
  'settings',
] as const
export type Route = (typeof ROUTES)[number]

export const TITLES: Record<Route, string> = {
  home: 'Home',
  'mail/inbox': 'Inbox',
  'mail/unclutter': 'Unclutter',
  'mail/history': 'Clean-up history',
  calendar: 'Calendar',
  finance: 'Finance',
  settings: 'Settings',
}

/** Routes live in the URL hash (`#/mail/inbox`) so the app can open on any screen. */
export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  return (ROUTES as readonly string[]).includes(path) ? (path as Route) : 'home'
}
