import { Inbox, MailCheck } from 'lucide-react'
import type { AccountStatus } from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import type { Route } from '../routes'

interface Props {
  account: AccountStatus | null
  onConnect: () => void
  onDisconnect: () => void
  onNavigate: (r: Route) => void
}

export function InboxPage({ account, onConnect, onDisconnect, onNavigate }: Props) {
  if (!account?.connected)
    return (
      <EmptyState
        icon={<Inbox size={40} strokeWidth={1.5} />}
        title="Connect your iCloud account"
        body="You'll need your Apple ID email and an app-specific password from account.apple.com. It's stored in your Keychain, never in a file."
        action={
          <Button variant="primary" onClick={onConnect}>
            Connect iCloud
          </Button>
        }
      />
    )
  return (
    <EmptyState
      icon={<MailCheck size={40} strokeWidth={1.5} />}
      title={`Connected as ${account.email}`}
      body="Reading your mail here is coming next. For now, scan your inbox and clear out automated mail in Unclutter."
      action={
        <div className="flex gap-2">
          <Button onClick={onDisconnect}>Disconnect</Button>
          <Button variant="primary" onClick={() => onNavigate('mail/unclutter')}>
            Open Unclutter
          </Button>
        </div>
      }
    />
  )
}
