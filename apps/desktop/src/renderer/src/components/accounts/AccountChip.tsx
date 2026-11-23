import type { AccountColor, MailAccount } from '@ordo/shared'

/** Each account colour as the system colour of that name (they read in light and dark). */
export const ACCOUNT_HEX: Record<AccountColor, string> = {
  blue: '#0a84ff',
  purple: '#bf5af2',
  pink: '#ff375f',
  red: '#ff453a',
  orange: '#ff9f0a',
  yellow: '#ffd60a',
  green: '#30d158',
  teal: '#40c8e0',
  graphite: '#98989d',
}

export const COLOR_NAMES: Record<AccountColor, string> = {
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  graphite: 'Graphite',
}

/** An account's colour dot. Decorative: the label beside it says which account. */
export function AccountDot({ color, size = 8 }: { color: AccountColor; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: ACCOUNT_HEX[color] }}
    />
  )
}

/** A small chip naming an account, for message rows and senders: its dot and its label. */
export function AccountChip({ account, className = '' }: { account: MailAccount; className?: string }) {
  return (
    <span
      title={account.email}
      className={`inline-flex max-w-[120px] min-w-0 items-center gap-1 text-[11px] ${className}`}
    >
      <AccountDot color={account.color} size={7} />
      <span className="truncate">{account.label}</span>
    </span>
  )
}
