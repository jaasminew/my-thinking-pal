# 01 · 概览与决策

[← 返回索引](../technical-plan.md)

## 1.1 产品定位（对照 AGENTS.md）

Thinking Pal 是实时思考工作台，不是会议纪要工具。核心约束：

- AI 延展并结构化人类思考，**不覆盖**人类撰写的内容。
- 输出语言跟随用户主导口语。
- AI 建议保持**相邻、视觉可区分、可 keep/reject**。

## 1.2 现状评估：为什么现在还不是产品

| 维度 | 现状 | 结论 |
| --- | --- | --- |
| 后端 | `server/api-plugin.ts` 是 **Vite dev 中间件**，仅 `npm run dev` 时挂载 | 无法独立部署，需重建 |
| LLM 密钥 | 握在 dev 层 `LLM` 注册表，经 `/api/cocreate` 中转 | 改为前端持有、直连 MaaS |
| CLI 路线 | `server/agents.ts` spawn 本机 `claude`/`codex` 复用订阅 | 仅本机实验，产品下线 |
| 持久化 | 笔记只在 `App.tsx` 的 `useState`，刷新即丢 | 引入本地优先 CRDT + 云端同步 |
| 账号 | 无 | 新建账号体系 |
| STT | `Transcript.tsx` 静态占位；`CommandBar` 录音按钮仅切布尔值 | 真实 STT，经后端转发 |
| 构建产物 | `out/` 有陈旧 Electron 产物，源码已无 electron 配置 | 早期试过，可重建 |

### 现有关键文件

- 前端画布：`canvas-cocreation/src/App.tsx`、`KeywordNoteView.tsx`、`Transcript.tsx`、`CommandBar.tsx`、`canvas-types.ts`
- LLM 契约：`services/llm/cocreate.ts`、`services/llm/cocreate-types.ts`
- Dev 后端：`server/api-plugin.ts`、`server/agents.ts`、`server/search.ts`、`server/proxy.ts`
- 入口构建：`index.html`、`vite.config.ts`

## 1.3 决策一：LLM 前端直连 MaaS，不走后端

**结论：是。但必须区分 STT 与 LLM。**

- **LLM 推理**（agent 核心调用 + 基于 LLM 的转写润色/翻译/断句）：前端用**用户自配 key 直连 MaaS**。
- **原始语音转文字（STT）**：走后端转发（模块 07）。
- 一句话：**声音 → 文字走后端；文字 → 更多文字走前端。**

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

唯一取舍——**Web 搜索**（现用我方 Tavily key，见 `server/search.ts`）：

- 初期：用户自配搜索 key，前端直连。
- 后期：像 STT 一样做成带计费的后端可选服务。

## 1.5 决策汇总

| 能力 | 归属 | 密钥归属 |
| --- | --- | --- |
| 笔记本地存储/编辑 | 客户端 | — |
| 笔记多端同步 | Go 后端中继 | — |
| 账号体系 | Go 后端 | — |
| LLM 推理 / agent | 客户端 | 用户 |
| STT 语音转写 | Go 后端转发 | 我方 |
| Web 搜索 | 初期客户端 / 后期后端 | 用户 → 我方 |
