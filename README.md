# Thinking Pal Canvas

Prototype for **My Thinking Pal**, a real-time thinking workspace for creators.
This is not production architecture; it is a test rig for canvas interaction feel,
model choice, search cards, latency, and prompt behavior.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

- Canvas co-creation: http://127.0.0.1:5173/

Validation:

```bash
npm run build
```

## Environment

Fill only the providers you are testing in `.env`. Do not commit `.env`; it is
intentionally gitignored.

Common variables:

- `CLAUDE_CODE_OAUTH_TOKEN`: Claude Code subscription route via local CLI.
- `TAVILY_API_KEY`: web-search inspiration cards.
- `GROQ_API_KEY`: hosted open-model backend for `Open + Tavily`.
- `CEREBRAS_API_KEY`: optional hosted open-model backend.
- `OLLAMA_BASE_URL` / `OLLAMA_MODEL`: local open-model backend.
- `HTTPS_PROXY`: hosted API proxy when needed.
- `AGENT_PROXY`: proxy override for Claude/Codex CLI calls.

## Canvas Co-Creation

The app is a working canvas interaction prototype:

- Static transcript on the left.
- Canvas on the right.
- Drag highlighted transcript phrases onto the canvas.
- Click blank canvas to create a freeform note.
- Human notes are editable and always treated as kept.
- AI appends adjacent suggestions, never overwrites human text.
- Hover AI suggestions or URL cards for keep / reject.
- Bottom command bar tests explicit commands and web-search inspiration.

Available backends:

- `Claude Code`: subscription route via local Claude CLI.
- `Codex`: subscription route via local Codex CLI.
- `Open + Tavily`: Groq / Ollama + Tavily search.

The active prototype uses a custom absolute-positioned canvas UI. `tldraw` is
installed, but the app is not wired to tldraw yet.

## Project Layout

```text
services/
  llm/                 Browser client for /api/cocreate
server/
  api-plugin.ts        Vite backend: Groq/Cerebras/Ollama proxy and /api/cocreate
  agents.ts            Claude Code / Codex CLI bridge
  search.ts            Tavily search bridge
canvas-cocreation/
  src/App.tsx          Canvas co-creation prototype
index.html             App entry
```

## Notes For Partners

- This repo intentionally keeps the prototype simple: Vite serves frontend and local API routes in one process.
- Browser code should not read provider keys directly; hosted model keys stay in the local API layer.
- AI suggestions should remain adjacent, visually distinct, and keep/reject-able.
