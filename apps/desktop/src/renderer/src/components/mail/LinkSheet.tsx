import { useId, useState } from 'react'
import { ExternalLink, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { CheckedLink } from '@ordo/mail-core'
import { Button } from '../Button'
import { Sheet } from '../Sheet'

interface Props {
  link: CheckedLink
  onClose: () => void
}

/**
 * Asked before any link from an email opens: shows exactly where it goes, and opens it in the
 * browser, never in Ordo. A link whose text names a different site is treated as a likely scam:
 * the safe choice is the default.
 */
export function LinkSheet({ link, onClose }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bodyId = useId()

  if (link.kind !== 'web')
    return (
      <Sheet
        title="Ordo won’t open this link"
        icon={<ShieldAlert size={22} />}
        width={440}
        describedBy={bodyId}
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
        <p id={bodyId} className="text-[13px] leading-snug text-ink-2">
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

  if (link.mismatch)
    return (
      <Sheet
        title="This link may be a scam"
        icon={<TriangleAlert size={22} />}
        iconTone="warning"
        width={480}
        busy={busy}
        describedBy={bodyId}
        onClose={onClose}
        footer={
          <>
            <span className="flex-1" />
            <Button onClick={() => void open()} disabled={busy}>
              Open anyway
            </Button>
            <Button variant="primary" onClick={onClose} disabled={busy} data-autofocus>
              Don’t open
            </Button>
          </>
        }
      >
        <p id={bodyId} className="text-[13px] leading-snug">
          The email shows <strong>{link.mismatch.shown}</strong>, but the link really goes to{' '}
          <strong>{link.mismatch.actual}</strong>. Scam emails do this to steal passwords. If you need{' '}
          {link.mismatch.shown}, type the address into your browser yourself.
        </p>
        <LinkBox url={link.url} host={link.host} />
        {error && <p className="text-[12px] text-danger-text">{error}</p>}
      </Sheet>
    )

  return (
    <Sheet
      title="Open this link in your browser?"
      subtitle={link.host}
      icon={<ExternalLink size={22} />}
      width={480}
      busy={busy}
      describedBy={bodyId}
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
      <div id={bodyId} className="flex flex-col gap-3">
        {!link.secure && (
          <p className="flex items-start gap-2 text-[13px] leading-snug text-ink-2">
            <TriangleAlert size={15} className="mt-0.5 shrink-0" />
            This link isn’t secure (http). Don’t enter passwords or card details on the page it opens.
          </p>
        )}
        <LinkBox url={link.url} host={link.host} />
      </div>
      {error && <p className="text-[12px] text-danger-text">{error}</p>}
    </Sheet>
  )
}

/** The full address, with the site it really goes to in bold. */
function LinkBox({ url, host }: { url: string; host?: string }) {
  const at = host ? url.toLowerCase().indexOf(host.toLowerCase()) : -1
  return (
    <p
      className="max-h-32 overflow-auto rounded-md border border-sep bg-field px-2.5 py-2 font-mono text-[12px] break-all text-ink select-text"
      aria-label="Link address"
    >
      {at >= 0 ? (
        <>
          {url.slice(0, at)}
          <strong className="font-bold">{url.slice(at, at + host!.length)}</strong>
          {url.slice(at + host!.length)}
        </>
      ) : (
        url
      )}
    </p>
  )
}
