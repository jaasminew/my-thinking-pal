// One-shot worker spawned per request by server.ts. Because it is a fresh
// process each time, it re-imports the prompt + context modules from disk on
// every call — so editing cocreate-prompt.ts is picked up on the NEXT Run with
// no server restart. Reads a JSON request on stdin, writes JSON on stdout.
//
//   { mode: 'meta' }                       → { base, search, cases }
//   { mode: 'run', input, model }          → RunResult

import { CASES } from './cases'
import { COCREATE_SYSTEM, SEARCH_INSTRUCTION, runOnce, type CaseInput } from './engine'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const req = JSON.parse((await readStdin()) || '{}') as
    | { mode: 'meta' }
    | { mode: 'run'; input: CaseInput; model?: string }

  if (req.mode === 'meta') {
    process.stdout.write(JSON.stringify({ base: COCREATE_SYSTEM, search: SEARCH_INSTRUCTION, cases: CASES }))
    return
  }
  if (req.mode === 'run') {
    const result = await runOnce(req.input, req.model)
    process.stdout.write(JSON.stringify(result))
    return
  }
  throw new Error(`unknown mode: ${(req as any).mode}`)
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e?.message || String(e) }))
  process.exit(1)
})
