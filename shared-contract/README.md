> ⚠️ **ARCHIVED / SUPERSEDED (2026-07).** This directory captured an earlier,
> third architecture (an operation-log `Backend` with `IdeaSpace` / `PipelineTopic`).
> It is **not used** by the app or the build, and has been superseded by the
> **local-first Yjs CRDT contract** (`packages/core/doc` + `docs/modules/04-data-model.md`
> for the doc model, `docs/modules/05-sync-protocol.md` for sync). Kept only for
> historical reference; do not build against it. See `docs/technical-plan.md` for
> the current architecture.

---

# Shared Contract — Thinking Pal

The coordination surface between the two tracks. Agree on this, then build in
parallel.

- **Web demo** (Jasmine) — deployed URL for the 7/15 hackathon. Owns UX
  correctness. Implements `Backend` over HTTP/WebSocket.
- **Electron production app** (partner) — scalable long-run app. Owns infra and
  scaling. Implements `Backend` over the preload IPC bridge.

Both program against the **same types**. Neither imports the other's transport.

## Files

| File            | What it fixes                                                        |
| --------------- | -------------------------------------------------------------------- |
| `domain.ts`     | The data model. `CanvasOperation` log is the single source of truth. |
| `providers.ts`  | `SttProvider` / `LlmProvider` — vendor-swappable interfaces.          |
| `projection.ts` | `foldOperations()` — the ONE way to rebuild canvas state from the log.|
| `backend.ts`    | `Backend` — the UI-facing API + the live `PipelineTopic` event stream.|

## The rule that makes parallel work possible

`backend.ts` defines an **interface**, not an implementation. Each track writes
its own class:

```ts
// Jasmine, web demo
class WebBackend implements Backend { /* fetch + WebSocket */ }

// Partner, Electron
class IpcBackend implements Backend { /* window.app preload bridge */ }
```

All UI code imports `Backend` and is transport-blind. The interaction patterns
Jasmine validates against `Backend` therefore transfer to the Electron app
without a UI rewrite — that is the actual handoff, not the URL.

## Change discipline (the part that actually matters)

This contract is **frozen enough, not frozen forever.** UX work will reveal it
needs to change. When it does:

1. Do **not** edit these files silently — a silent change breaks the other
   track's parallel work and they find out late.
2. Add a dated line to the changelog below and ping the other person **before**
   merging the change.
3. Prefer **additive** changes (new optional field, new topic) over breaking
   ones (renamed/removed field) while both tracks are mid-build.

## Frozen vs. negotiable (as of Day 1)

- **Frozen:** `CanvasOperation` shape and the append-only log model;
  `PipelineTopic` names; the provider interface method signatures.
- **Negotiable this week:** exact `CanvasOperationKind` set (may add kinds);
  `NoteCard` / `NoteBullet` fields; agent command payload.

## Changelog

- `YYYY-MM-DD` — v0.1 initial contract, lifted from the `electron-client` branch
  and made transport-neutral. (fill in the date when you both sign off)
