import { Wallet } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'

export function FinancePage() {
  return (
    <EmptyState
      icon={<Wallet size={40} strokeWidth={1.5} />}
      title="Finance is on the way"
      body="Once Mail is done, this is where budgets, subscriptions and bills will live."
    />
  )
}
