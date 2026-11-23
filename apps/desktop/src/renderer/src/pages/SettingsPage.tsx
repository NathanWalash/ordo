import { useEffect, useState, type ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { AccountStatus, AiSettings as Ai, Settings, Theme } from '@ordo/shared'
import { AiSettings } from '../components/AiSettings'
import { BackupSettings } from '../components/BackupSettings'
import { GoogleSettings } from '../components/GoogleSettings'
import { SegmentedControl } from '../components/SegmentedControl'
import { UpdateSettings } from '../components/UpdateSettings'
import { Row, Section } from '../components/SettingsSection'
import { AccountsSection } from '../components/accounts/AccountsSection'
import { useAppearance } from '../appearance'

const THEME_OPTIONS = [
  { value: 'system', label: 'System', icon: <Monitor size={13} /> },
  { value: 'light', label: 'Light', icon: <Sun size={13} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
] as const satisfies readonly { value: Theme; label: string; icon: ReactNode }[]

interface Props {
  account: AccountStatus | null
  onConnect: () => void
  /** Forget every account (kept for callers from before several accounts). */
  onDisconnect?: () => void
  /** Accounts were added, changed or removed. */
  onAccountsChanged?: () => void
}

/** App preferences, grouped into sections: mail accounts, Google, appearance, AI and updates. */
export function SettingsPage({ account, onConnect, onAccountsChanged }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const appearance = useAppearance()

  useEffect(() => {
    let live = true
    void window.ordo.settings.get().then((s) => live && setSettings(s))
    return () => {
      live = false
    }
  }, [])

  const setTheme = async (theme: Theme) => {
    setSettings((s) => s && { ...s, theme })
    setSettings(await window.ordo.settings.set({ theme }))
  }

  const setAi = async (ai: Ai) => {
    setSettings((s) => s && { ...s, ai })
    setSettings(await window.ordo.settings.set({ ai }))
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-8">
      {account && (
        // Keyed by the account list, so connecting from the sheet shows the new account.
        <AccountsSection
          key={account.connected ? account.accounts.map((a) => a.id).join() : 'none'}
          onConnectIcloud={onConnect}
          onChanged={() => onAccountsChanged?.()}
        />
      )}
      <GoogleSettings
        accountsKey={account?.connected ? account.accounts.map((a) => a.id).join() : 'none'}
        onAccountsChanged={() => onAccountsChanged?.()}
      />
      <Section title="Appearance">
        <Row
          label="Theme"
          detail="System matches your computer's light or dark setting."
          control={
            settings && (
              <SegmentedControl
                label="Theme"
                options={THEME_OPTIONS}
                value={settings.theme}
                onChange={(t) => void setTheme(t)}
              />
            )
          }
        />
        {appearance?.reducedTransparency && (
          <Row
            label="Transparency"
            detail="Reduce transparency is on in your system settings, so Ordo uses solid backgrounds."
          />
        )}
      </Section>
      {settings && <AiSettings ai={settings.ai} onSave={setAi} />}
      <UpdateSettings />
      <BackupSettings />
    </div>
  )
}
