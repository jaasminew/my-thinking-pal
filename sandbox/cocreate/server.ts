// Web playground server for the co-creation prompt. Left pane shows the live
// system prompt (read-only); right pane is an editable form where you fill in
// your own session data and Run it against the real Codex call.
//
//   npm run sandbox:web         # then open http://127.0.0.1:5188
//
// The server holds NO prompt state of its own: every /api/meta and /api/run
// spawns a fresh vite-node worker that re-reads the prompt from disk, so any
// edit I make to cocreate-prompt.ts shows up on your next Refresh / Run.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const DIR = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname)
const PORT = Number(process.env.SANDBOX_PORT) || 5188
const VITE_NODE = path.join(process.cwd(), 'node_modules', '.bin', 'vite-node')
const WORKER = path.join(DIR, 'worker.ts')

// Spawn the one-shot worker, feed it a JSON request on stdin, resolve its JSON reply.
function callWorker(req: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(VITE_NODE, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', reject)
    child.on('close', (code) => {
      // vite-node prints its own banner to stderr; only treat as fatal if no JSON came back.
      const start = out.indexOf('{')
      const end = out.lastIndexOf('}')
      if (start < 0 || end < start) {
        reject(new Error(err.trim() || out.trim() || `worker exited ${code} with no output`))
        return
      }
      try {
        resolve(JSON.parse(out.slice(start, end + 1)))
      } catch (e: any) {
        reject(new Error(`bad worker JSON: ${e?.message}; raw: ${out.slice(0, 300)}`))
      }
    })
    child.stdin.write(JSON.stringify(req))
    child.stdin.end()
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
  res.end(s)
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = fs.readFileSync(path.join(DIR, 'ui.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (req.method === 'GET' && req.url === '/api/meta') {
      json(res, 200, await callWorker({ mode: 'meta' }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/run') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await callWorker({ mode: 'run', input: body.input, model: body.model })
      json(res, 200, result)
      return
    }
    res.writeHead(404)
    res.end('not found')
  } catch (e: any) {
    json(res, 500, { error: e?.message || String(e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Co-creation playground → http://127.0.0.1:${PORT}\n`)
})
