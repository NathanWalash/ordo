// Node-only parts of calendar-core (CalDAV and SQLite). Import from '@ordo/calendar-core/node'
// in the Electron main process; never in the renderer.
export {
  CalDavProvider,
  CalendarAuthError,
  CalendarConnectionError,
  ICLOUD_CALDAV_URL,
  isReadOnly,
  normaliseColor,
  type CalDavConfig,
} from './caldav'
export { CalendarStore, type CalendarSyncState, type StoredCalendar } from './store'
export { syncCalendars, type SyncOptions } from './sync'
