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
  FEED_MAX_BYTES,
  FeedError,
  FeedProvider,
  fetchFeed,
  type Feed,
  type FeedErrorKind,
  type FeedKind,
  type FeedUrlCheck,
} from './feeds'
export { syncCalendars, type SyncOptions } from './sync'
