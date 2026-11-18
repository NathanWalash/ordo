import { useState } from 'react'
import { ExternalLink, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { CheckedLink } from '@ordo/mail-core'
import { Button } from '../Button'
import { Sheet } from '../Sheet'

interface Props {
  link: CheckedLink
  onClose: () => void
}

/**
 * Asked before any link from an email opens: shows exactly where it goes, warns when the text
 * named a different site or the link isn't secure, and opens it in the browser, never in Ordo.
 */
export function LinkSheet({ link, onClose }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (link.kind !== 'web')
    return (
      <Sheet
        title="Ordo won’t open this link"
        icon={<ShieldAlert size={22} />}
        width={440}
        onClose={onClose}
        onSubmit={onClose}
        footer={
          <>
            <span className="flex-1" />
            <Button type="submit" variant="primary">
              OK
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-snug text-ink-2">
          {link.kind === 'refused' ? link.reason : 'Not a web link.'}
        </p>
        <LinkBox url={link.url} />
      </Sheet>
    )

  const open = async () => {
    setBusy(true)
    const r = await window.ordo.mail.openLink(link.url)
    setBusy(false)
    if (r.ok) onClose()
    else setError(r.message)
  }

  const host = link.host
  return (
    <Sheet
      title="Open this link in your browser?"
      subtitle={host}
      icon={<ExternalLink size={22} />}
      width={480}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void open()}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Open link
          </Button>
        </>
      }
    >
      {link.mismatch && (
        <p className="flex items-start gap-2 text-[13px] leading-snug text-danger" role="alert">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          The link says {link.mismatch.shown}, but it goes to {link.mismatch.actual}. Scam emails do this.
          Only open it if you trust the sender.
        </p>
      )}
      {!link.secure && (
        <p className="flex items-start gap-2 text-[13px] leading-snug text-ink-2">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          This link isn’t secure (http). Don’t enter passwords or card details on the page it opens.
        </p>
      )}
      <LinkBox url={link.url} />
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Sheet>
  )
}

function LinkBox({ url }: { url: string }) {
  return (
    <p
      className="max-h-32 overflow-auto rounded-md border border-sep bg-field px-2.5 py-2 font-mono text-[12px] break-all text-ink select-text"
      aria-label="Link address"
    >
      {url}
    </p>
  )
}
