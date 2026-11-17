import { useEffect, useState, type ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { Settings, Theme } from '@ordo/shared'
import { SegmentedControl } from '../components/SegmentedControl'
import { useAppearance } from '../appearance'

const THEME_OPTIONS = [
  { value: 'system', label: 'System', icon: <Monitor size={13} /> },
  { value: 'light', label: 'Light', icon: <Sun size={13} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
] as const satisfies readonly { value: Theme; label: string; icon: ReactNode }[]

/** App preferences, grouped into sections. Accounts and AI sorting will join Appearance here. */
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
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `settings-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={id} className="mb-8">
      <h2 id={id} className="mb-2 px-1 text-[13px] font-semibold text-ink-2">
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-sep">{children}</div>
    </section>
  )
}

function Row({ label, detail, control }: { label: string; detail?: string; control?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-4 border-b border-sep px-4 py-2.5 last:border-b-0">
      <div className="flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {detail && <div className="text-[12px] leading-snug text-ink-2">{detail}</div>}
      </div>
      {control}
    </div>
  )
}
