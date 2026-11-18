// Node-only parts of calendar-core (CalDAV and SQLite). Import from '@ordo/calendar-core/node'
// in the Electron main process; never in the renderer.
export {
  CalDavProvider,
  CalendarAuthError,
  CalendarConnectionError,
  CalendarWriteError,
  CalendarUnavailableError,
  ICLOUD_CALDAV_URL,
  inside,
  isReadOnly,
  normaliseColor,
  type CalDavConfig,
} from './caldav'
export {
  createEvent,
  deleteEvent,
  EventChangeError,
  eventDetails,
  refreshCalendar,
  updateEvent,
  type CalendarEventRef,
  type ChangeOptions,
  type EventChangeErrorKind,
  type EventDetails,
} from './edit'
export {
  CalendarStore,
  FEEDS,
  ICLOUD,
  type CalendarSyncState,
  type StoredCalendar,
  type StoredFeed,
} from './store'
export {
  checkFeedUrl,
  describeIcs,
  readIcs,
  FEED_MAX_BYTES,
  LOCAL_ADDRESS_MESSAGE,
  FeedError,
  FeedProvider,
  fetchFeed,
  type Feed,
  type FeedErrorKind,
  type FeedKind,
  type FeedUrlCheck,
  type FetchFeedOptions,
} from './feeds'
export { syncCalendars, type SyncOptions } from './sync'
