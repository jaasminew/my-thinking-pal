# 03 · 数据模型与存储

[← 返回索引](../technical-plan.md)

## 本地优先 CRDT

每个画布一个 `Y.Doc`，由 `packages/core/doc/board.ts` 的 `Board` / `openBoard(docId)` 管理。浏览器持久化：`apps/web/src/board-persistence.ts` → `y-indexeddb`，键名 `thinking-pal.board.{docId}`。另有 `localStorage` 镜像备份（应用层）。

根结构：

| Y 根 | 用途 |
| --- | --- |
| `Y.Array notes` | 关键词笔记 |
| `Y.Array images` | 画布级贴图 |
| `Y.Map meta` | 元数据 |
| `Y.Map transcript` | 转写结晶（opaque JSON：`frozen` + `tail`） |

## 内容模型（`schema.ts`）

持久化形状**不含** UI 临时态（`keywordEditing` / `aiRunning` / item `editing`），读写时剥离或默认。

- **Origin**：`human` | `ai`
- **ItemStatus**：`pending` | `kept`（人类内容视为 kept）
- **PlainItem**：`bullet` | `card` | `image`
- **PlainNote**：`id, x, y, keyword, items[], kept[], rejected[], lastFiredWords`，以及 Observer 等可选字段（`originTs`, `sourceText`, `originSignalType`）
- **BoardContent**：`{ notes, images }`

人类子弹始终可编辑且视为 kept；AI 条目默认 `pending`，keep 写入 `kept` 文案信号，reject 删除并记入 `rejected`。

## Board API（要点）

`notes` / `images` / `content` / `observe` / `upsertNote` / `patchNote` / `setItems` / `appendItem` / `getTranscript` / `setTranscript` / `whenSynced` / `destroy` 等。同步提供者通过 `BoardPersistence` 注入；云端见 [04](04-sync-protocol.md)。

## 服务端存储（与画布分离）

Go SQLite（`AccountStore`）：账号、documents 元数据、workspace JSON、refresh hash、project-memory 行等。CRDT 字节在 DocStore（文件快照 + 更新日志），**不**解析业务字段。Project Memory 见 [09](09-project-memory.md)。
