import { useState } from 'react'
import { CalendarPlus, FileUp } from 'lucide-react'
import type { CalendarListItem } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'

interface Props {
  onClose: () => void
  onAdded: (calendar: CalendarListItem) => void
}

/**
 * Add a calendar Ordo can't reach through iCloud: subscribe by its link (Google's secret iCal
 * address, Outlook's published ICS link, any webcal:// feed) or import an .ics file once.
 */
export function AddCalendarSheet({ onClose, onAdded }: Props) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'link' | 'file' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const subscribe = async () => {
    setBusy('link')
    setError(null)
    setFileError(null)
    try {
      const r = await window.ordo.calendar.addLink({ url })
      if (r.ok) onAdded(r.calendar)
      else setError(r.message)
    } catch {
      setError('Something went wrong adding that calendar. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  const importFile = async () => {
    setBusy('file')
    setError(null)
    setFileError(null)
    try {
      const r = await window.ordo.calendar.importFile()
      if (!r) return
      if (r.ok) onAdded(r.calendar)
      else setFileError(r.message)
    } catch {
      setFileError('Something went wrong importing that file. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet
      title="Add a calendar"
      subtitle="Subscribe by link to see a calendar that isn’t in iCloud, like a Google work calendar."
      icon={<CalendarPlus size={22} />}
      width={500}
      busy={busy !== null}
      onClose={onClose}
      onSubmit={() => void subscribe()}
      footer={
        <>
          <Button icon={<FileUp size={14} />} onClick={() => void importFile()} disabled={busy !== null}>
            {busy === 'file' ? 'Importing…' : 'Import .ics file…'}
          </Button>
          <span className="flex-1" />
          <Button onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy !== null || !url.trim()}>
            {busy === 'link' ? 'Checking…' : 'Subscribe'}
          </Button>
        </>
      }
    >
      <TextField
        label="Calendar link"
        placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        error={error ?? undefined}
        hint="Anyone with this link can see the calendar, so Ordo keeps it encrypted on this computer."
        spellCheck={false}
        autoComplete="off"
      />
      <details className="text-[12px] leading-snug text-ink-2">
        <summary className="cursor-default font-medium text-ink">Where do I find the link?</summary>
        <ul className="mt-1.5 list-disc space-y-1 pl-4">
          <li>
            <span className="font-medium text-ink">Google Calendar:</span> on the web, open Settings, choose
            the calendar under “Settings for my calendars”, then copy “Secret address in iCal format”. If it’s
            missing, your work’s admin has turned it off.
          </li>
          <li>
            <span className="font-medium text-ink">Outlook:</span> Settings › Calendar › Shared calendars ›
            Publish a calendar, then copy the ICS link.
          </li>
          <li>
            <span className="font-medium text-ink">Anything else:</span> a link starting with webcal:// or
            ending in .ics.
          </li>
        </ul>
        <p className="mt-1.5">
          Subscribed calendars are read-only, and Google can take a few hours to show changes in the link. For
          a Google calendar, connect your Google account in Settings › Google instead: changes show within
          minutes and you can edit events.
        </p>
      </details>
      {fileError && (
        <p role="alert" className="text-[12px] text-danger">
          {fileError}
        </p>
      )}
    </Sheet>
  )
}
