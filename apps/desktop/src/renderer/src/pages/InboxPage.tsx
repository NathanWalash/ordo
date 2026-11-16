import { Inbox } from 'lucide-react'
import { EmptyState, PrimaryButton } from '../components/EmptyState'
import type { Route } from '../routes'

export function InboxPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <EmptyState
      icon={<Inbox size={40} strokeWidth={1.5} />}
      title="Connect your iCloud account"
      body="You'll need your Apple ID and an app-specific password from account.apple.com. It's stored in your Keychain, never in a file."
      action={<PrimaryButton onClick={() => onNavigate('mail/unclutter')}>Preview Unclutter</PrimaryButton>}
    />
  )
}
