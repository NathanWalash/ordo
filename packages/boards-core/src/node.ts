// Node-only parts of boards-core (SQLite). Import from '@ordo/boards-core/node' in the Electron
// main process; never in the renderer.
export { BoardsError, BoardsStore, LIMITS, type BoardsErrorCode, type CardPatch, type NewCard } from './store'
