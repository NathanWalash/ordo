import { useEffect, useState, type ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { AiSettings as Ai, Settings, Theme } from '@ordo/shared'
import { AiSettings } from '../components/AiSettings'
import { SegmentedControl } from '../components/SegmentedControl'
import { Row, Section } from '../components/SettingsSection'
import { useAppearance } from '../appearance'

const THEME_OPTIONS = [
  { value: 'system', label: 'System', icon: <Monitor size={13} /> },
  { value: 'light', label: 'Light', icon: <Sun size={13} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
] as const satisfies readonly { value: Theme; label: string; icon: ReactNode }[]

/** App preferences, grouped into sections. Accounts will join Appearance and AI here. */
export function SettingsPage() {
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
    </div>
  )
}
