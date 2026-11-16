import type { OrdoApi } from '@ordo/shared'

declare global {
  interface Window {
    ordo: OrdoApi
  }
}
