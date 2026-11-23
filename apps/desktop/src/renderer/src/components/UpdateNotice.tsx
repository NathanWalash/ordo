import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import type { UpdateState } from '@ordo/shared'
import { Button } from './Button'

/**
 * "Ordo 0.2.0 is available" in the bottom corner when the launch check finds a release you
 * haven't skipped. Download opens the installer in your browser; nothing is downloaded or run by
 * Ordo. Later hides it until next launch; Skip this version hides it for good.
 */
export function UpdateNotice() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void window.ordo.updates.state().then((s) => live && setState(s))
    const off = window.ordo.updates.onChanged((s) => setState(s))
    return () => {
      live = false
      off()
    }
  }, [])

  const update = state?.last?.status === 'available' ? state.last : null
  if (!update || update.skipped || dismissed === update.version || !state?.checksEnabled) return null

  const skip = async () => setState(await window.ordo.updates.skip(update.version))

  return (
    <aside
      aria-label="Update available"
      className="glass-panel absolute right-5 bottom-5 z-[55] w-[320px] rounded-xl p-4 text-[13px]"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <h2 className="font-semibold">Ordo {update.version} is available</h2>
          <p className="text-[12px] text-ink-2">You have {state.currentVersion}.</p>
        </div>
        <button
          type="button"
          aria-label="Remind me later"
          title="Remind me later"
          onClick={() => setDismissed(update.version)}
          className="no-drag -mt-1 -mr-1 flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
      {update.notes && (
        <p className="mt-2 line-clamp-4 whitespace-pre-line text-[12px] leading-snug text-ink-2">
          {update.notes}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={() => void skip()}>Skip this version</Button>
        <Button
          variant="primary"
          icon={<Download size={13} />}
          onClick={() => void window.ordo.updates.open()}
          title={update.assetName ?? 'Open the release page'}
        >
          Download
        </Button>
      </div>
    </aside>
  )
}
