import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { apiPlugin } from './server/api-plugin'

// Single-process dev: Vite serves the frontend AND mounts the /api/* backend
// (LLM proxy + Deepgram key) via apiPlugin. One `npm run dev`, HMR included.
export default defineConfig(({ mode }) => {
  // Load every var from .env into process.env so the Node-side plugin can read them.
  // Skip empty values so a blank line in .env doesn't wipe a var that launch.json
  // already set (e.g. HTTPS_PROXY for hosted APIs).
  const env = loadEnv(mode, process.cwd(), '')
  for (const [k, v] of Object.entries(env)) {
    if (v !== '') process.env[k] = v
  }
  return {
    plugins: [react(), apiPlugin()],
    server: { port: 5173, open: true },
    // Multi-page: index.html is Unit 1 (default), unit2.html is Unit 2.
    build: {
      rollupOptions: {
        input: { main: 'index.html', unit2: 'unit2.html' }
      }
    }
  }
})
