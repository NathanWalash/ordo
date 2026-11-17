import type { CalendarStore } from './store'
import type { CalendarProvider, CalendarSyncProgress, CalendarSyncResult, DateRange } from './types'

export interface SyncOptions {
  /** Span to cache; see `syncWindow()`. */
  window: DateRange
  signal?: AbortSignal
  onProgress?: (p: CalendarSyncProgress) => void
  /** Refetch every calendar even if its version is unchanged. */
  force?: boolean
}

/**
 * Bring the cache up to date with the provider: refresh the calendar list, then refetch
 * the events of each calendar that changed (or whose cached window no longer covers
 * `window`). The provider must already be connected.
 */
export async function syncCalendars(
  provider: CalendarProvider,
  store: CalendarStore,
  { window, signal, onProgress, force = false }: SyncOptions,
): Promise<CalendarSyncResult> {
  const calendars = await provider.listCalendars()
  store.setCalendars(calendars)
  const result: CalendarSyncResult = {
    calendars: calendars.length,
    fetched: 0,
    skipped: 0,
    events: 0,
    stopped: false,
  }

  for (const [i, cal] of calendars.entries()) {
    onProgress?.({ done: i, total: calendars.length, current: cal.name })
    if (signal?.aborted) return { ...result, stopped: true }
    const state = store.syncState(cal.id)
    const fresh =
      !force &&
      state !== null &&
      cal.version !== undefined &&
      state.version === cal.version &&
      state.from <= window.start &&
      state.to >= window.end
    if (fresh) {
      result.skipped++
      continue
    }
    const events = await provider.fetchEvents(cal.id, window)
    if (signal?.aborted) return { ...result, stopped: true }
    store.replaceEvents(cal.id, events, window, cal.version)
    result.fetched++
    result.events += events.length
  }
  onProgress?.({ done: calendars.length, total: calendars.length })
  return result
}
