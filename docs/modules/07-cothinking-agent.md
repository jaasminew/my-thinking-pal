# 07 · Co-thinking Agent

[← 返回索引](../technical-plan.md)

## 产品约束

AI 只在人类想法旁追加建议，不改写人类正文。语言跟随用户。建议默认 `pending`，须 keep/reject。

## 环境共创（ambient cocreate）

触发（`App.tsx`）：AI 开关开；当前画布；笔记未在 `aiRunning` / `keywordEditing`；人类词数相对 `lastFiredWords` 增量 ≥ **20**，且空闲 ≥ **5s**。

流水线：`requestCocreate`（`services/llm/cocreate.ts`）+ `packages/core/llm/cocreate-prompt.ts`；可开 web search。流式写入 pending bullet/card。

**Keep**：`status: kept`，文案记入 `note.kept`（可含 diagnosis）。  
**Reject**：删除条目，记入 `note.rejected`；流式中拒绝的行不会被同 fire 重建。

关键 UI：`KeywordNoteView.tsx`。`lastFiredWords` 存在 CRDT 笔记上（跨设备一致）。

## Observer（旁路）

基于转写信号的环境评估 / 贡献：冷却与门控后可能新建笔记或补充。引擎纯逻辑在 `apps/web/src/observer-engine.ts`；LLM I/O 在 `services/llm/observer.ts`、`observer-search.ts`；类型与解析在 `packages/core/llm/observer-*`。

## Command AI（显式）

选区 → 气泡 → 右侧命令面板聊天（`services/llm/command-chat.ts`、`apps/web/src/command-session.ts`）。可提议画布 ACTION，但**不自动落地**；落地内容仍为 pending，需 keep/reject。

## 传输

与全局一致：BYOK 直连或托管 `/llm`（见 [01](01-architecture.md)）。Project Memory 上下文可挂到共创/命令请求（见 [09](09-project-memory.md)）。
