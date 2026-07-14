# Thinking Pal Canvas

Prototype for **My Thinking Pal**, a real-time thinking workspace for creators
(not a meeting-notes app). AI extends human thought beside the canvas; it does
not overwrite human-authored content.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173/

Full guide (local / backend / desktop, env vars, tests): [`docs/BUILD_AND_DEBUG.md`](docs/BUILD_AND_DEBUG.md).  
Architecture index: [`docs/technical-plan.md`](docs/technical-plan.md).

```bash
npm test
npm run build
```

Desktop (Electron) reuses `apps/web`:

```bash
npm run dev            # terminal 1
npm run dev:desktop    # terminal 2
```

## Environment

Do not commit `.env`. Never document real API keys or production server IPs —
env var names and placeholders only.

Common variables (see `.env.example` and `AGENTS.md`):

- `GROQ_API_KEY` — local-only / BYOK LLM fallback (dev inject in `npm run dev`)
- `TAVILY_API_KEY` — web-search cards (Vite `/api/search` locally; Go `/search` when signed in)
- `DEEPSEEK_*` — hosted LLM on Go (`POST /llm/chat/completions`)
- `SONIOX_*` — STT (browser-direct locally; Go `/stt` when signed in)
- `VITE_API_URL` — optional Go backend; **empty = local-only**
- `HTTPS_PROXY` — outbound proxy when needed

## Canvas behavior

- Drag transcript phrases onto the canvas; blank click creates a note.
- Human bullets are editable and kept; AI suggestions are pending until keep/reject.
- Custom positioned-note canvas (not tldraw).

## Layout

```text
apps/web/          React renderer
apps/desktop/      Electron shell
packages/core/     CRDT + LLM parsing + settings
services/          api / sync / stt / llm / project-memory
server/            Dev Vite relay (search, url-meta, local-ai)
server-go/         Optional Go backend
docs/              Architecture modules + build guide
```
