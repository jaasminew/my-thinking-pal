# Shared Contract

Live wire types shared by the web client and Go backend JSON.

| File | Role |
| --- | --- |
| [`project-memory.ts`](project-memory.ts) | Project Memory scopes, files, instructions, retrieval context |

The older op-log `Backend` / `IdeaSpace` contract files were removed; canvas state is the Yjs CRDT model in `packages/core/doc` (see [`docs/modules/03-data-model.md`](../docs/modules/03-data-model.md) and [`docs/modules/04-sync-protocol.md`](../docs/modules/04-sync-protocol.md)).

Architecture index: [`docs/technical-plan.md`](../docs/technical-plan.md).
