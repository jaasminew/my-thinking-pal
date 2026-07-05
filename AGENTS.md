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

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

- Canvas co-creation: http://127.0.0.1:5173/

Before handing off changes:

```bash
npm run build
```

## Environment

Do not commit `.env`.

Common variables:

- `GROQ_API_KEY`: hosted open-model provider for co-creation.
- `TAVILY_API_KEY`: canvas web-search cards.
- `HTTPS_PROXY`: hosted API proxy when needed.
- `AGENT_PROXY`: proxy override for Claude/Codex CLI calls.

## Canvas Architecture

Active files:

- `canvas-cocreation/src/App.tsx`
- `canvas-cocreation/src/KeywordNoteView.tsx`
- `canvas-cocreation/src/Transcript.tsx`
- `services/llm/cocreate.ts`
- `server/api-plugin.ts`
- `server/agents.ts`
- `server/search.ts`

Behavior:

- Transcript phrases can be dragged onto the canvas.
- Blank canvas click creates a note.
- Human bullets are editable and always treated as kept.
- AI bullets are pending until keep/reject.
- Rejected ideas are removed and remembered as negative signals.
- URL cards come only from real search.

Do not claim the canvas uses tldraw in active code. The dependency is installed, but
the current prototype uses a custom positioned-note canvas.
