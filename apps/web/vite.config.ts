import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the built assets load whether the server hosts the app at
// `/` or behind a path. The Fastify server serves `dist/` (see server/src).
// `host: true` exposes the dev server on the LAN so a phone can reach it.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: true,
  },
})
