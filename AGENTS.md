# Agent Instructions

This repo contains the canvas co-creation prototype for My Thinking Pal. Keep
changes pragmatic and focused on preserving the intended product behavior.

## Product Intent

Thinking Pal is a real-time thinking workspace, not a meeting-notes app. The goal
is to help a creator preserve and extend ideas while speaking or listening.

Core constraints:

- AI extends and structures human thought; it does not overwrite human-authored content.
- Output language should match the user's dominant spoken language.
- AI suggestions should remain adjacent, visually distinct, and keep/reject-able.

## Run And Validate

Full build/debug guide (three run modes, env vars, tests, common pitfalls):
[`docs/BUILD_AND_DEBUG.md`](docs/BUILD_AND_DEBUG.md).

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

- Canvas co-creation: http://127.0.0.1:5173/

Desktop (Electron) shell — reuses the same `apps/web` renderer:

```bash
npm run dev            # terminal 1: Vite dev server (5173)
npm run dev:desktop    # terminal 2: Electron window loading the dev server
npm run build:desktop  # production-domain installers → apps/desktop/release/
npm run build:desktop:local # local-only installers
```

Before handing off changes:

```bash
npm run build
```

## Environment

Do not commit `.env`.

Common variables:

- `GROQ_API_KEY`: hosted open-model provider (co-creation + transcript cleanup/summary). In `npm run dev` a compile-time inject (`services/dev-keys.ts`) fills it in; in prod the user enters keys in the LLM settings panel (stored in the browser). No keys are baked into the shipped bundle.
- `TAVILY_API_KEY`: canvas web-search cards (server-side `/api/search` relay).
- `SONIOX_API_KEY` / `SONIOX_MODEL`: STT. Browser-direct via the dev-only inject in local mode; when signed into the Go backend, held server-side and used by the `/stt` relay.
- `HTTPS_PROXY`: hosted API proxy when needed (server-side search/url-meta relay).
- `VITE_API_URL` (web build-time): points the app at the Go backend (`server-go/`) to enable login, cross-device board sync (`/sync`), and backend STT (`/stt`). **Empty = local-only mode** (no login, IndexedDB-only, browser-direct Soniox) — nothing regresses.

## Architecture (post Phase 0/1/2)

The LLM is now **client-direct** to the MaaS provider (Groq by default); the Vite
middleware is a **minimal relay** only for web search + og:image. CLI providers
(`agents.ts`) are retired. Notes/images persist **local-first via Yjs CRDT**
(`packages/core/doc` + IndexedDB), with `localStorage` kept as a mirror/backup.

An optional **Go backend** (`server-go/`) adds accounts (SQLite), cross-device
board sync (`/sync` dumb relay), and STT forwarding (`/stt`). It's **opt-in via
`VITE_API_URL`**: unset → the app runs exactly as before (local-only, no login).
Signed in → each canvas maps to a server document and syncs live; speech routes
through the backend STT proxy. See `docs/technical-plan.md`.

Active files:

- Frontend canvas: `apps/web/src/App.tsx`, `KeywordNoteView.tsx`, `Transcript.tsx`
- CRDT persistence: `packages/core/doc/{schema,board}.ts`, `apps/web/src/board-persistence.ts`
- LLM (client-direct, tested): `packages/core/llm/*`, `services/llm/{client,cocreate,command-chat,provider-config,web-search}.ts`
- Minimal backend relay (dev): `server/api-plugin.ts`, `server/search.ts`, `server/url-meta.ts`, `server/proxy.ts`
- Go backend: `server-go/` (auth/JWT, SQLite AccountStore, `/documents`, `/workspace`, `/sync` CRDT relay, `/stt` proxy). Tests: `cd server-go && make test`.
- Backend wiring (frontend, gated by `VITE_API_URL`): `services/api/*` (auth+documents+workspace client), `services/sync/board-sync.ts` (Yjs provider), `services/stt/backend.ts` (STT via `/stt`), `apps/web/src/{backend.ts,AuthPanel.tsx}`.

Tests: `npm test` (Vitest). Run it (plus `npm run build`) before handing off.

Behavior:

- Transcript phrases can be dragged onto the canvas.
- Blank canvas click creates a note.
- Human bullets are editable and always treated as kept.
- AI bullets are pending until keep/reject.
- Rejected ideas are removed and remembered as negative signals.
- URL cards come only from real search.

Do not claim the canvas uses tldraw in active code. The dependency is installed, but
the current prototype uses a custom positioned-note canvas.

## GitHub Publishing

- Treat Git-over-SSH authentication and GitHub CLI authentication as separate.
  An invalid `gh auth status` does not imply that `git push` is unavailable;
  verify SSH access independently before reporting a push blocker.
- Before opening a PR, inspect `git log origin/<base>..HEAD` and the full diff
  against the intended base. Report or resolve pre-existing branch commits so
  the PR scope is understood before publication.
- Prefer the connected GitHub app for PR creation when SSH push works but the
  local `gh` token is unavailable.
