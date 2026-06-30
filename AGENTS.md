# Agent Instructions

This repo contains prototype units for My Thinking Pal. Keep changes pragmatic and
focused on preserving the intended product behavior.

## Product Intent

Thinking Pal is a real-time thinking workspace, not a meeting-notes app. The goal
is to help a creator preserve and extend ideas while speaking or listening.

Core constraints:

- AI extends and structures human thought; it does not overwrite human-authored content.
- Unit 1 must not display raw STT by default.
- Unit 1 should display one evolving structured note, not a stream of transcript chunks.
- Unit 1 highlights are marked by the model with `==double equals==` and rendered by the client.
- Output language should match the user's dominant spoken language.
- Unit 2 AI suggestions should remain adjacent, visually distinct, and keep/reject-able.

## Run And Validate

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

- Unit 1: http://127.0.0.1:5173/
- Unit 2: http://127.0.0.1:5173/unit2.html

Before handing off changes:

```bash
npm run build
```

## Environment

Do not commit `.env`.

Common variables:

- `SONIOX_API_KEY`: preferred Unit 1 STT provider.
- `GROQ_API_KEY`: preferred Unit 1 cleanup/notes provider.
- `TAVILY_API_KEY`: Unit 2 web-search cards.
- `HTTPS_PROXY`: hosted API proxy when needed.
- `AGENT_PROXY`: proxy override for Claude/Codex CLI calls.

## Unit 1 Architecture

Active files:

- `unit1-stt-highlight/src/main.ts`
- `unit1-stt-highlight/src/cleanup.ts`
- `unit1-stt-highlight/src/render.ts`
- `server/api-plugin.ts`
- `services/llm/client.ts`
- `services/llm/types.ts`

Flow:

1. STT adapter emits raw final chunks.
2. `CleanupEngine` buffers raw text invisibly.
3. A pause plus minimum length threshold triggers `/api/clean-transcript`.
4. The request sends only the new raw chunk plus existing cleaned notes as context.
5. The server asks the model for the full updated visible note.
6. The client replaces the visible note and renders `==...==` as highlights.

Important implementation rules:

- Do not send the same raw STT chunk twice in normal operation.
- Do not append every pause as a separate visible block.
- Do not render model reasoning. `sanitizeCleanedTranscript` is the server guard.
- If adding a reasoning model, update `getReasoningParams`.
- Keep `Stop` as a force flush so short final thoughts are not lost.

## Unit 2 Architecture

Active files:

- `unit2-canvas-cocreation/src/App.tsx`
- `unit2-canvas-cocreation/src/KeywordNoteView.tsx`
- `unit2-canvas-cocreation/src/Transcript.tsx`
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

Do not claim Unit 2 uses tldraw in active code. The dependency is installed, but
the current prototype uses a custom positioned-note canvas.
