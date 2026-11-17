import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Workspace packages ship TypeScript source, so they must be bundled, not externalised.
const workspace = ['@ordo/shared', '@ordo/mail-core', '@ordo/ai', '@ordo/money-core']

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: workspace } },
  },
  preload: {
    // Sandboxed preloads cannot require() packages at runtime: bundle everything.
    build: { externalizeDeps: false },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react(), tailwindcss()],
  },
})
