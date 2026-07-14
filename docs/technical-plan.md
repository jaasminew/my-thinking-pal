# Thinking Pal 技术方案（总览与索引）

> 实时思考工作台（不是会议纪要工具）——说话/倾听时保存并延展想法。

文档以**当前仓库实现**为准。上手运行见 [BUILD_AND_DEBUG.md](BUILD_AND_DEBUG.md)；给 agent 的约束见根目录 [AGENTS.md](../AGENTS.md)。

## 一句话架构

- **客户端**（Web / Electron）：画布、本地优先 Yjs CRDT、共创与转写结晶、LLM（BYOK 直连或登录后托管）。
- **Go 后端**（`VITE_API_URL` 可选）：账号、workspace、`/sync` 哑中继、`/stt`、鉴权 `/search`、托管 `/llm`、Project Memory 哑存储。
- **未设 `VITE_API_URL`**：纯本地（IndexedDB、浏览器 Soniox、Vite 搜索 relay），行为不回归。

声音 → 文字：本地直连 Soniox，或登录后走后端 `/stt`。  
文字 → 更多文字：有个人 key 则前端直连 MaaS；已登录且无个人 key 则 `POST /llm/chat/completions`。

## 模块索引

| # | 模块 | 文档 |
| --- | --- | --- |
| 01 | 系统架构 | [modules/01-architecture.md](modules/01-architecture.md) |
| 02 | 账号与鉴权 | [modules/02-auth-and-accounts.md](modules/02-auth-and-accounts.md) |
| 03 | 数据模型与存储 | [modules/03-data-model.md](modules/03-data-model.md) |
| 04 | 同步协议 | [modules/04-sync-protocol.md](modules/04-sync-protocol.md) |
| 05 | Go 后端 | [modules/05-backend-go.md](modules/05-backend-go.md) |
| 06 | STT 与录制状态 | [modules/06-stt-forwarding.md](modules/06-stt-forwarding.md) |
| 07 | Co-thinking Agent | [modules/07-cothinking-agent.md](modules/07-cothinking-agent.md) |
| 08 | 桌面端 Electron | [modules/08-desktop-electron.md](modules/08-desktop-electron.md) |
| 09 | Project Memory | [modules/09-project-memory.md](modules/09-project-memory.md) |
| 10 | 转写与共创机制 | [modules/10-transcript-and-cocreate.md](modules/10-transcript-and-cocreate.md) |

## 仓库结构

```text
apps/web/          React 渲染
apps/desktop/      Electron 壳
packages/core/     CRDT schema/board、LLM 解析、设置
services/          api / sync / stt / llm / project-memory
server/            本地 Vite relay（search / url-meta / local-ai）
server-go/         可选 Go 后端
shared-contract/   跨端 wire 类型（现为 project-memory）
docs/              本索引与 modules
```

## 阅读顺序

1. 01 架构 → 03 数据模型  
2. 后端：02 → 04 → 05 → 06 → 09  
3. 产品机制：10 → 07 → 08  
