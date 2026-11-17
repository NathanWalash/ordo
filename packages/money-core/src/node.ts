// Node-only parts of money-core (SQLite). Import from '@ordo/money-core/node' in the
// Electron main process; never in the renderer.
export { MoneyStore } from './store'
