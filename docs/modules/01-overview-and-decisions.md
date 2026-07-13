# 01 · 概览与决策

[← 返回索引](../technical-plan.md)

## 1.1 产品定位（对照 AGENTS.md）

Thinking Pal 是实时思考工作台，不是会议纪要工具。核心约束：

- AI 延展并结构化人类思考，**不覆盖**人类撰写的内容。
- 输出语言跟随用户主导口语。
- AI 建议保持**相邻、视觉可区分、可 keep/reject**。

## 1.2 现状评估与进度（Phase 0/1 已落地，Phase 2 进行中）

| 维度 | 原始现状 | 进度 |
| --- | --- | --- |
| 后端 | `server/api-plugin.ts` 是 **Vite dev 中间件** | ✅ **已瘦身**为最小 relay（仅 `/api/search`、`/api/url-meta`）；dev key 握手端点 `/api/llm-config`、`/api/soniox-key` **已下线**，改为编译期 dev 注入（`services/dev-keys.ts`）；LLM 逻辑全迁至 `packages/core/llm`。✅ **Go 后端 `server-go/` 已起**（Auth/JWT/argon2id + documents + `/sync` 同步中继） |
| LLM 密钥 | 握在 dev 层注册表，经 `/api/cocreate` 中转 | ✅ **前端直连 MaaS**（本地-only / BYOK）：key 存浏览器；✅ **登录态托管**：无个人 key 时走 Go `POST /llm/chat/completions`（DeepSeek Flash/Pro） |
| CLI 路线 | `server/agents.ts` spawn 本机 `claude`/`codex` | ✅ **已下线** `agents.ts`；Web 默认 Groq 直连，移除 CLI 选择器 |
| 持久化 | 笔记只在 `App.tsx` 的 `useState`/`localStorage` | ✅ **本地优先 CRDT**（Yjs + `y-indexeddb`，`packages/core/doc`）；✅ 云端同步哑中继 `/sync` 已实现，✅ **前端已接线**：登录后每个 space 映射一个 server 文档，`BoardSync` 挂上 `board.doc`（`VITE_API_URL` 开启，未配置则纯本地） |
| 账号 | 无 | ✅ **Go 后端已实现**（注册/登录/刷新轮换/me，argon2id + HS256 JWT）；✅ **SQLite 持久化**（`modernc.org/sqlite` 纯 Go，重启不丢，`ACCOUNT_STORE=sqlite`）；✅ **前端登录 UI 已接**（`AuthPanel` + `useBackend`，token 存浏览器，401 自动刷新） |
| STT | 浏览器直连 Soniox（`/api/soniox-key` 取 key） | ✅ **Go `/stt` 后端转发已实现**（可插拔 soniox/tencent/mock，后端持 key）；✅ **前端已接线**：登录后 Transcript 用 `BackendSTT` 经后端转发，未登录回退浏览器直连 Soniox（key 走 dev 编译期注入，`/api/soniox-key` 已下线） |
| 构建产物 | `out/` 陈旧 Electron 产物 | ⏳ Electron 壳后置（Phase 3） |

### 现有关键文件

- 前端画布：`apps/web/src/App.tsx`、`KeywordNoteView.tsx`、`Transcript.tsx`、`CommandBar.tsx`、`canvas-types.ts`
- CRDT 本地优先：`packages/core/doc`（schema/board）、`apps/web/src/board-persistence.ts`
- LLM 客户端直连：`packages/core/llm/*`、`services/llm/{client,cocreate,command-chat,provider-config,web-search}.ts`
- 最小 dev 后端：`server/api-plugin.ts`、`server/search.ts`、`server/url-meta.ts`、`server/proxy.ts`（search relay 用；`agents.ts` 已删）
- 入口构建：`index.html`、`vite.config.ts`

## 1.3 决策一：LLM 默认前端直连；登录态可走托管代理

**结论：区分本地-only / BYOK 与登录托管；仍与 STT 分开。**

- **LLM 推理**：本地-only 或用户在设置里填了个人 key（BYOK）→ 前端直连 MaaS；**已登录且无个人 key** → Go `POST /llm/chat/completions`（后端持 `DEEPSEEK_API_KEY`，Listener=Flash，Thinker=Pro）。
- **原始语音转文字（STT）**：走后端转发（模块 07）。
- 一句话：**声音 → 文字走后端；文字 → 更多文字：登录托管或前端直连。**

理由：

1. 我方不持有 key、不承担 token 成本。
2. 我方网络未必直达各 MaaS，前端直连规避。
3. 无每用户后端推理负载。
4. 思考内容不经我方服务器，隐私更好。

注意事项（详见模块 08）：

- CORS：Groq/OpenAI/OpenRouter 通常允许浏览器直连；Anthropic 原生较严格。Electron 无 CORS 限制。
- Key 存储：Electron `safeStorage`；Web IndexedDB + 风险提示。

## 1.4 决策二：co-thinking agent 跑客户端

**结论：跑客户端（前端）。**

1. 零每用户后端负载，与"不托管 key、网络未必可达"自洽。
2. 上下文就在本地（transcript 窗口、`kept`/`rejected`、`existingIdeas` 都在本地 CRDT 文档）。
3. 隐私：思考内容不经我方服务器。
4. 本地优先契合：agent 直接读写本地 Yjs 文档。

唯一取舍——**Web 搜索 / og:image**（见 `server/search.ts`、`server/url-meta.ts`）：

- **已定（Phase 0）**：保留**最小后端 relay**（`/api/search` + `/api/url-meta`）承载真实搜索与 og:image 抓取——浏览器受 CORS 限制、且 Tavily key + 国内代理更适合在服务端；对应「URL 卡片只来自真实搜索」。前端 LLM 已直连，仅这两项走后端。
- 后期：并入 Go 后端，像 STT 一样加账号识别与计费/限流。

## 1.5 决策汇总

| 能力 | 归属 | 密钥归属 |
| --- | --- | --- |
| 笔记 + transcript 本地存储/编辑 | 客户端 | — |
| 笔记 + transcript 多端同步 | Go 后端中继 | — |
| 账号体系 | Go 后端 | — |
| LLM 推理 / agent | 客户端 | 用户 |
| STT 语音转写 | Go 后端转发 | 我方 |
| Web 搜索 / og:image | 生产：Go `/search`+`/url-meta`（登录态）；本地-only：Vite `/api/*` | 我方（Tavily） |
