import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    // Runs before every test file: no real network, and iCloud hosts point at a closed local port.
    setupFiles: ['./test/network-guard.ts'],
  },
})
