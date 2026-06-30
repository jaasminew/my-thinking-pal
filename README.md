# Thinking Pal Units

Prototype units for **My Thinking Pal**, a real-time thinking workspace for creators.
These pages are not production architecture; they are test rigs for interaction feel,
model choice, latency, and prompt behavior.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

- Unit 1: http://127.0.0.1:5173/
- Unit 2: http://127.0.0.1:5173/unit2.html

Use Chrome for microphone / tab-audio capture.

## Environment

Fill only the providers you are testing in `.env`.

Required for the current Unit 1 happy path:

```bash
SONIOX_API_KEY=...
GROQ_API_KEY=...
```

Optional in China / proxied networks:

```bash
HTTPS_PROXY=http://127.0.0.1:7890
AGENT_PROXY=http://127.0.0.1:7890
```

Do not commit `.env`. It is intentionally gitignored.

## Unit 1 - STT To Structured Thinking Notes

Current workflow:

1. Browser captures mic / tab audio.
2. Soniox produces raw streaming STT.
3. Raw STT is **not displayed**.
4. After a natural pause and minimum chunk threshold, the new raw chunk goes to Groq.
5. Groq updates one visible, concise, structured thinking note.
6. The UI renders only Groq's cleaned note; `==highlighted ideas==` become highlights.

Important behavior:

- The visible note is replaced with the updated structured note each model call.
- Raw STT chunks are not resent as raw text.
- Existing cleaned notes are sent as context so the model can merge, dedupe, and revise.
- The output should match the user's dominant language.
- The default model is `openai/gpt-oss-20b`; `qwen/qwen3.6-27b` also works.

Useful controls:

- `Audio source`: mic, tab audio, or both.
- `STT provider`: Soniox is the preferred default.
- `Groq model`: switch between GPT-OSS, Qwen, Llama, etc.
- `Pause`: default `1500ms`.
- `Minimum chunk`: prevents tiny speech fragments from being sent to the model.
- `System prompt`: controls how raw speech is converted into structured notes.

Validation:

```bash
npm run build
```

API smoke test:

```bash
curl -sS http://127.0.0.1:5173/api/clean-transcript \
  -H 'Content-Type: application/json' \
  --data '{
    "provider":"groq",
    "model":"qwen/qwen3.6-27b",
    "systemPrompt":"You turn rough live STT into concise structured thinking notes. Match the user language. Mark key ideas with ==double equals==.",
    "existingNotes":"",
    "rawText":"qwen 三点六做得很好 但是它输出的语言没有匹配用户"
  }'
```

Expected shape:

```json
{"markedText":"* ==Qwen 3.6 表现良好==，但输出语言需要匹配用户输入"}
```

## Unit 2 - Canvas Co-Creation

Unit 2 is a working canvas interaction prototype:

- Static transcript on the left.
- Canvas on the right.
- Drag highlighted transcript phrases onto the canvas.
- Click blank canvas to create a freeform note.
- Human notes are editable.
- AI appends adjacent suggestions, never overwrites human text.
- Hover AI suggestions or URL cards for keep / reject.
- Bottom command bar tests Tier-3 explicit commands and web-search inspiration.

Open:

```bash
npm run dev
# http://127.0.0.1:5173/unit2.html
```

Backends:

- `Claude Code`: subscription route via local Claude CLI.
- `Codex`: subscription route via local Codex CLI.
- `Open + Tavily`: Groq / Ollama + Tavily search.

Unit 2 currently uses a custom absolute-positioned canvas UI. `tldraw` is installed,
but the active prototype is not wired to tldraw yet.

## Project Layout

```text
services/
  stt/                 Shared STT adapters and audio-source helpers
  llm/                 Browser clients for /api/highlight, /api/clean-transcript, /api/cocreate
server/
  api-plugin.ts        Vite backend: provider keys, Groq/Cerebras proxy, STT key endpoints
  agents.ts            Claude Code / Codex CLI bridge for Unit 2
  search.ts            Tavily search bridge for Unit 2
unit1-stt-highlight/
  src/cleanup.ts       Hidden raw STT -> evolving structured note engine
  src/render.ts        Renders ==highlight== markers
unit2-canvas-cocreation/
  src/App.tsx          Canvas co-creation prototype
index.html             Unit 1 entry
unit2.html             Unit 2 entry
```

## Notes For Partners

- This repo intentionally keeps the prototype simple: Vite serves frontend and local API routes in one process.
- Browser code never reads provider keys directly except local prototype STT key endpoints.
- Production should replace local key endpoints with temporary-token minting.
- Do not reintroduce raw transcript rendering in Unit 1 unless explicitly testing raw STT quality.
- Keep the model output visible only after server-side sanitization; reasoning leaks are rejected.
