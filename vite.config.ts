import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { apiPlugin } from './server/api-plugin'

// Single-process dev: Vite serves the frontend and mounts the /api/* backend
// for local co-creation experiments. One `npm run dev`, HMR included.
export default defineConfig(({ mode }) => {
  // Load every var from .env into process.env so the Node-side plugin can read them.
  // Skip empty values so a blank line in .env doesn't wipe a var that launch.json
  // already set (e.g. HTTPS_PROXY for hosted APIs).
  const env = loadEnv(mode, process.cwd(), '')
  for (const [k, v] of Object.entries(env)) {
    if (v !== '') process.env[k] = v
  }
  // Dev-only key inject (replaces the retired /api/llm-config + /api/soniox-key
  // handoffs). In production this is `null` so the browser relies on the in-app
  // settings UI / OS keychain — no keys are baked into the shipped bundle.
  const devLlmKeys =
    mode === 'production'
      ? null
      : {
          groq: { key: env.GROQ_API_KEY || '', model: env.GROQ_MODEL || 'openai/gpt-oss-20b' },
          cerebras: { key: env.CEREBRAS_API_KEY || '', model: env.CEREBRAS_MODEL || 'llama3.1-8b' },
          ollama: {
            key: '',
            model: env.OLLAMA_MODEL || 'qwen3:1.7b',
            baseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434/v1'
          },
          soniox: { key: env.SONIOX_API_KEY || '', model: env.SONIOX_MODEL || 'stt-rt-v5' }
        }
  return {
    plugins: [react(), apiPlugin()],
    define: { __DEV_LLM_KEYS__: JSON.stringify(devLlmKeys) },
    server: { port: 5173, open: true }
  }
})
