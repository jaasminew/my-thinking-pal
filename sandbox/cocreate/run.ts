// Co-creation prompt sandbox — CLI batch runner. Sends every fixture case
// through the shared engine (real prompt + context + parsers + Codex) and writes
// a markdown report that shows this run side by side with the previous one.
//
//   npm run sandbox                  # all cases
//   npm run sandbox -- --case pass   # cases whose name contains "pass"
//   npm run sandbox -- --model gpt-5.6-terra
//
// Reports land in sandbox/cocreate/runs/ (latest.md is always the newest).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CASES } from './cases'
import { COCREATE_SYSTEM, DEFAULT_MODEL, SEARCH_INSTRUCTION, runOnce, type RunResult } from './engine'

const RUNS_DIR = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'runs')

interface CaseResult extends RunResult {
  name: string
}

interface RunRecord {
  stamp: string
  model: string
  promptHash: string
  results: CaseResult[]
}

function parseArgs(argv: string[]) {
  const out: { caseFilter?: string; model: string } = { model: DEFAULT_MODEL }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') out.caseFilter = argv[++i]
    else if (argv[i] === '--model') out.model = argv[++i]
  }
  return out
}

function renderResult(r?: CaseResult): string {
  if (!r) return '_no data_'
  if (r.error) return `⚠️ error: ${r.error}`
  const p = r.parsed!
  const lines: string[] = []
  lines.push(`- _diagnosis:_ ${p.diagnosis || '(none)'}`)
  lines.push(`- _anchor:_ ${p.anchor === null ? 'NONE' : p.anchor}`)
  if (p.passed) lines.push('- **PASS**')
  for (const b of p.bullets) lines.push(`- **${b.replace(/^-\s*/, '')}**`)
  if (p.search) lines.push(`- _search${p.search.image ? ' image' : ''}:_ \`${p.search.query}\``)
  for (const u of p.urls) lines.push(`- _cited link:_ [${u.title}](${u.url})`)
  lines.push(`- _${(r.ms / 1000).toFixed(1)}s_`)
  return lines.join('\n')
}

function renderReport(run: RunRecord, prev?: RunRecord): string {
  const caseByName = new Map(CASES.map((c) => [c.name, c]))
  const prevByName = new Map((prev?.results ?? []).map((r) => [r.name, r]))
  const out: string[] = []
  out.push(`# Co-creation sandbox — ${run.stamp}`)
  out.push('')
  out.push(
    `Model \`${run.model}\` · prompt \`${run.promptHash}\`` +
      (prev ? ` · compared against ${prev.stamp} (prompt \`${prev.promptHash}\`)` : '')
  )
  out.push('')
  for (const r of run.results) {
    const c = caseByName.get(r.name)
    out.push(`## ${r.name}`)
    if (c) {
      out.push(`**Tests:** ${c.tests}`)
      out.push('')
      out.push(`**Good output:** ${c.expect}`)
    }
    out.push('')
    out.push(`### This run (\`${run.promptHash}\`)`)
    out.push(renderResult(r))
    const prevR = prevByName.get(r.name)
    if (prevR) {
      out.push('')
      out.push(`### Previous run (\`${prev!.promptHash}\`, ${prev!.stamp})`)
      out.push(renderResult(prevR))
    }
    out.push('')
    out.push('<details><summary>Exact user message sent</summary>')
    out.push('')
    out.push('```text')
    out.push(r.userText.replace(/```/g, '` ` `'))
    out.push('```')
    out.push('')
    out.push('</details>')
    out.push('')
  }
  return out.join('\n')
}

async function main() {
  const { caseFilter, model } = parseArgs(process.argv.slice(2))
  const cases = caseFilter ? CASES.filter((c) => c.name.includes(caseFilter)) : CASES
  if (!cases.length) {
    console.error(`No case matches "${caseFilter}". Available: ${CASES.map((c) => c.name).join(', ')}`)
    process.exit(1)
  }
  const promptHash = createHash('sha256').update(COCREATE_SYSTEM + SEARCH_INSTRUCTION).digest('hex').slice(0, 8)
  console.log(`Running ${cases.length} case(s) on ${model} · prompt ${promptHash}`)

  const results = await Promise.all(
    cases.map((c) =>
      runOnce(c, model).then((r) => {
        console.log(`  ${r.error ? '⚠️' : '✓'} ${c.name} (${(r.ms / 1000).toFixed(1)}s)`)
        return { ...r, name: c.name }
      })
    )
  )

  const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 19)
  const run: RunRecord = { stamp, model, promptHash, results }

  fs.mkdirSync(RUNS_DIR, { recursive: true })
  let prev: RunRecord | undefined
  const latestJson = path.join(RUNS_DIR, 'latest.json')
  try {
    prev = JSON.parse(fs.readFileSync(latestJson, 'utf8'))
  } catch {
    /* first run */
  }

  const report = renderReport(run, prev)
  fs.writeFileSync(path.join(RUNS_DIR, `${stamp}.md`), report)
  fs.writeFileSync(path.join(RUNS_DIR, `${stamp}.json`), JSON.stringify(run, null, 2))
  fs.writeFileSync(path.join(RUNS_DIR, 'latest.md'), report)
  fs.writeFileSync(latestJson, JSON.stringify(run, null, 2))
  console.log(`\nReport: sandbox/cocreate/runs/latest.md`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
