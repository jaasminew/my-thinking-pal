# 10 · 前端画布与状态重构

[← 返回索引](../technical-plan.md)

保留现有画布交互与视觉，把底层状态从 React `useState` 迁到 **Yjs 文档派生 + 本地 UI 态叠加**。

## 10.1 现有交互（保留）

来自 `App.tsx` / `KeywordNoteView.tsx`：

- 从左侧 transcript 拖拽短语到画布 → 新建 note。
- 空白点击 → 新建 note；拖拽空白 → 框选。
- human bullet 可编辑、恒为 kept；AI bullet pending，可 ✓/✕。
- URL 卡片 hover 可 keep/reject。
- 底部命令栏（Tier-3 显式命令）。

这些交互**不变**，只改数据来源。

## 10.2 状态分层

```mermaid
flowchart TB
  subgraph crdt [CRDT 文档 - 同步]
    notes[notes: x/y/keyword/bullets/cards/kept/rejected]
  end
  subgraph local [本地 UI 态 - 不同步]
    ui[keywordEditing / editing / aiRunning / lastFiredWords]
    sel[selectedIds / marquee]
  end
  subgraph awareness [Yjs Awareness - 广播不持久化]
    cursor[他人光标 / 选区（多人协作，后期）]
  end
  notes --> view[NoteView 派生]
  local --> view
  view --> render[KeywordNoteView 渲染]
```

## 10.3 绑定层设计

新增 `packages/core/doc` 提供 React 绑定：

```ts
// 打开/创建一个 board 文档
const doc = openBoard(docId)              // Y.Doc + 本地持久化 + 同步 provider

// React hook：订阅 notes，产出派生 NoteView[]
const notes = useBoardNotes(doc)          // 内部用 doc.observeDeep -> setState

// 变更 API（写 CRDT，而非 setNotes）
board.addNote({ x, y, keyword })
board.updateNoteKeyword(noteId, text)
board.appendBullet(noteId, { origin, text, status, fireId })
board.keepBullet(noteId, bulletId)
board.rejectBullet(noteId, bulletId)
board.appendCard(noteId, card)
```

- 本地 UI 态仍用 React `useState`/`useReducer`，与派生的 `NoteView` 合并渲染。
- `App.tsx` 中现有的纯 UI 逻辑（拖拽、框选、就地编辑的 open/close）保留在本地态层。

## 10.4 改造对照表

| 现有（`App.tsx`） | 改造后 |
| --- | --- |
| `const [notes, setNotes] = useState<KeywordNote[]>([])` | `const notes = useBoardNotes(doc)`（派生） |
| `setNotes(ns => ...)` 内容变更 | 调 `board.*` 写 CRDT |
| `keywordEditing/editing/aiRunning` 混在 note 里 | 拆到本地 UI 态 |
| `runAi` 内 `setNotes` 追加 AI bullet | `board.appendBullet(...)`（模块 09） |
| `TRANSCRIPT_TEXT` 静态 | 来自 STT 实时转写（模块 07） |

## 10.5 转写面板（Transcript）改造

- `Transcript.tsx` 从静态 `LINES` 改为消费 STT 事件流（模块 07）。
- 保留「短语可拖拽到画布」的交互：对实时/定稿文本切分出可拖拽片段。
- 关键词高亮（现有 `<mark className="kw">`）可由客户端轻量规则或 agent 辅助标注（后期）。

## 10.6 多 board 与导航

- 顶部/侧边增加 board 列表（来自后端 `GET /documents`）。
- 每个 board 对应一个 Yjs 文档与同步连接；切换 board 即切换文档。

## 10.7 打包目标

- `apps/web`：Vite 构建 + PWA（离线可用，配合本地持久化）。
- `apps/desktop`：Electron（模块 11）。
- 共享 `packages/core`（CRDT/agent/LLM/类型）。
