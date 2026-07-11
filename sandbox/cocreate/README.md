# Co-creation prompt sandbox

Rapid iteration loop for the ambient co-creation prompt
([packages/core/llm/cocreate-prompt.ts](../../packages/core/llm/cocreate-prompt.ts)).

Every run sends the fixture cases in [cases.ts](cases.ts) through the **real**
pipeline — `COCREATE_SYSTEM` (+ `SEARCH_INSTRUCTION`), `buildCocreateContext`,
and the app's own response parsers — against the real Codex CLI, using the same
`codex exec` invocation the desktop app uses.

There are two front-ends over the same engine ([engine.ts](engine.ts)):

- **Web playground** (`npm run sandbox:web`) — a two-pane page. Left shows the
  live system prompt (read-only). Right is an editable form: fill in your own
  session data (or load a fixture as a starting point) and hit Run to see the
  parsed result. Best for exploring one case at a time with your own data.
- **CLI batch** (`npm run sandbox`) — runs all fixture cases at once and writes
  a markdown report comparing this run to the previous one. Best for a
  regression sweep after a prompt edit.

## The loop (web playground)

1. Notice a problem with the AI output; describe the vibe/problem to Claude.
2. Claude edits `cocreate-prompt.ts`.
3. In the page, hit **↻ refresh** (or just Run — every Run re-reads the prompt
   from disk in a fresh worker; no server restart needed).
4. Run your case; judge the result.
5. Not satisfied → back to step 2.

## Commands

```sh
npm run sandbox:web                # web playground → http://127.0.0.1:5188
npm run sandbox                    # CLI: all cases, default model gpt-5.6-terra
npm run sandbox -- --case pass     # CLI: only cases whose name contains "pass"
npm run sandbox -- --model <id>    # CLI: different Codex model
```

The web playground picks up prompt edits with no restart because the server
holds no prompt state: every request spawns a fresh `vite-node` worker that
re-imports `cocreate-prompt.ts` from disk.

## Reading a report

Each case shows:

- **Tests** — the one behavior this case exercises.
- **Good output** — your review checklist for judging the result.
- **This run / Previous run** — diagnosis, anchor, bullets (or PASS),
  search intent, cited links, latency.
- A collapsed block with the exact user message sent, for debugging.

## Adding a case (e.g. from a real session)

Copy any object in `cases.ts`, paste the real transcript window / note bullets /
kept–rejected lists, and write `expect` as the checklist you'll judge outputs
against. Fields mirror `CocreateRequest`, so real app data drops in unchanged.
