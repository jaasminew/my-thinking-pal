import type { Plugin } from 'vite'
import type { ServerResponse } from 'node:http'
import { tavilySearch } from './search'
import { fetchUrlMeta } from './url-meta'
import { checkLocalRuntime, runLocalAi, setupLocalRuntime, type LocalRuntime } from './local-ai'

// Dev-only backend relay. After the LLM moved CLIENT-DIRECT (docs module 08),
// the browser talks to the MaaS provider itself, so this middleware only keeps
// the handful of capabilities a browser genuinely can't do:
//
//   /api/search    real web search (Tavily key + CN proxy) — "URL cards only
//                  from real search"
//   /api/url-meta  og:image / og:description scraping (blocked by CORS in-page)
//
// The former dev-only key handoffs (`/api/llm-config`, `/api/soniox-key`) were
// RETIRED: keys now come from the in-app LLM settings UI (localStorage) / OS
// keychain on desktop, with a dev-only compile-time inject for `npm run dev`
// convenience (see services/dev-keys.ts). All LLM prompt/stream/parse logic
// lives in packages/core/llm.
export function apiPlugin(): Plugin {
  return {
    name: 'thinking-pal-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''

        if (url.startsWith('/api/local-ai')) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
          if (req.method === 'OPTIONS') {
            res.statusCode = 204
            return res.end()
          }
        }

        // --- GET /api/search?q=…&n=1 : minimal web-search relay -------------
        if (url.startsWith('/api/search')) {
          const q = new URL(url, 'http://localhost').searchParams
          const query = q.get('q') || ''
          const n = Math.max(1, Math.min(5, parseInt(q.get('n') || '1', 10) || 1))
          if (!query.trim()) return json(res, 400, { results: [] })
          try {
            return json(res, 200, { results: await tavilySearch(query, n) })
          } catch (e: any) {
            // 200 + empty so co-creation degrades to words-only, never hard-errors.
            return json(res, 200, { results: [], error: e?.message || String(e) })
          }
        }

        // --- GET /api/url-meta?url=… : og description + image for a card ---
        if (url.startsWith('/api/url-meta')) {
          const target = new URL(url, 'http://localhost').searchParams.get('url') || ''
          if (!/^https?:\/\//.test(target)) return json(res, 400, {})
          return json(res, 200, await fetchUrlMeta(target))
        }

        if (url.startsWith('/api/local-ai/status') && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const runtime = body?.runtime as LocalRuntime
            if (!isLocalRuntime(runtime)) return json(res, 400, { ok: false, error: 'Unknown local runtime' })
            return json(res, 200, await checkLocalRuntime(runtime, body.command, body.model))
          } catch (e: any) {
            return json(res, 500, { ok: false, error: e?.message || String(e) })
          }
        }

        if (url.startsWith('/api/local-ai/run') && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const runtime = body?.runtime as LocalRuntime
            if (!isLocalRuntime(runtime)) return json(res, 400, { error: 'Unknown local runtime' })
            if (typeof body.system !== 'string' || typeof body.userText !== 'string') {
              return json(res, 400, { error: 'system and userText are required' })
            }
            return json(res, 200, await runLocalAi({
              runtime,
              command: body.command,
              model: body.model,
              system: body.system,
              userText: body.userText
            }))
          } catch (e: any) {
            return json(res, 500, { error: e?.message || String(e) })
          }
        }

        if (url.startsWith('/api/local-ai/setup') && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const runtime = body?.runtime as LocalRuntime
            if (!isLocalRuntime(runtime)) return json(res, 400, { ok: false, error: 'Unknown local runtime' })
            return json(res, 200, await setupLocalRuntime(runtime, body.command))
          } catch (e: any) {
            return json(res, 500, { ok: false, error: e?.message || String(e) })
          }
        }

        next()
      })
    }
  }
}

function json(res: ServerResponse, code: number, obj: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

function isLocalRuntime(value: unknown): value is LocalRuntime {
  return value === 'codex' || value === 'claude-code' || value === 'cursor'
}

function readJson(req: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
