import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import type { UpdateState } from '@ordo/shared'
import { Button } from './Button'
import { Row, Section } from './SettingsSection'
import { Switch } from './Switch'

function lastChecked(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : ` Last checked ${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
}

function status(state: UpdateState): string {
  const last = state.last
  if (!last) return `You have Ordo ${state.currentVersion}.${lastChecked(state.lastCheckedAt)}`
  if (last.status === 'error') return last.message
  if (last.status === 'up-to-date') return `Ordo ${state.currentVersion} is the latest version.`
  return `Ordo ${last.version} is available. You have ${state.currentVersion}.${last.skipped ? ' You skipped this version.' : ''}`
}

/**
 * Settings → Updates: the version, a Check for updates button and the automatic-check switch.
 * Checking asks GitHub for the latest release and nothing else; Download opens your browser.
 */
export function UpdateSettings() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let live = true
    void window.ordo.updates.state().then((s) => live && setState(s))
    return () => {
      live = false
    }
  }, [])

  const check = async () => {
    setChecking(true)
    try {
      setState(await window.ordo.updates.check())
    } finally {
      setChecking(false)
    }
  }

  const setEnabled = async (enabled: boolean) => {
    setState((s) => s && { ...s, checksEnabled: enabled })
    setState(await window.ordo.updates.setChecksEnabled(enabled))
  }

  if (!state) return null
  const available = state.last?.status === 'available' ? state.last : null

  return (
    <Section title="Updates">
      <Row
        label="Version"
        detail={
          <span role="status">{checking ? 'Checking GitHub for a newer version…' : status(state)}</span>
        }
        control={
          available ? (
            <Button
              variant="primary"
              icon={<Download size={13} />}
              onClick={() => void window.ordo.updates.open()}
              title={available.assetName ?? 'Open the release page'}
            >
              Download {available.version}
            </Button>
          ) : (
            <Button onClick={() => void check()} disabled={checking}>
              Check for updates
            </Button>
          )
        }
      />
      <Row
        label="Check for updates automatically"
        detail={
          state.packaged
            ? 'Once a day, Ordo asks GitHub for the latest release. Nothing about you is sent, and nothing is downloaded until you choose to.'
            : 'Development builds only check when you ask.'
        }
        control={
          <Switch
            label="Check for updates automatically"
            checked={state.checksEnabled}
            onChange={(on) => void setEnabled(on)}
          />
        }
      />
    </Section>
  )
}
