# 08 · LLM 客户端直连

[← 返回索引](../technical-plan.md)

把现有 `server/api-plugin.ts` 中的 LLM 逻辑整体迁到客户端，改为**用户自配 key 直连 MaaS**。这是 Phase 0 的核心改造。

## 8.1 迁移映射（从 dev 后端到客户端）

| 现有位置（`server/api-plugin.ts`） | 迁移到客户端 | 说明 |
| --- | --- | --- |
| `COCREATE_SYSTEM` / `COMMAND_SYSTEM` / `SEARCH_INSTRUCTION` | `packages/core/llm/prompts.ts` | 系统提示词原样保留 |
| `buildCocreateContext` / `buildCommandContext` | `packages/core/llm/context.ts` | 上下文组装 |
| `streamOpenModel`（SSE 解析、`<think>` 剥离、`SEARCH:` 拦截、按行 flush） | `packages/core/llm/stream.ts` | 改为直连 provider |
| `LLM` provider 注册表（`base/key/model`） | `packages/core/llm/providers.ts` | key 改为用户输入 |
| `server/agents.ts`（Claude/Codex CLI） | **下线** | 仅本机实验；Electron 可选保留（模块 11） |
| `server/proxy.ts`（undici ProxyAgent） | **下线** | 客户端用自身网络环境 |
| `services/llm/cocreate.ts`（fetch `/api/cocreate`） | 改为直连 provider 的 `/chat/completions` | 契约层保留、实现替换 |

## 8.2 Provider 抽象

```ts
// packages/core/llm/providers.ts
export interface LlmProvider {
  id: string            // 'groq' | 'openai' | 'openrouter' | 'ollama' | 'custom'
  label: string
  baseUrl: string       // e.g. https://api.groq.com/openai/v1
  apiKey: string        // 用户输入（Ollama 可为空）
  model: string
  kind: 'openai-compatible' | 'anthropic'
}
```

- 统一走 **OpenAI 兼容 `/chat/completions`（stream）**，覆盖 Groq / OpenAI / OpenRouter / Cerebras / 本地 Ollama。
- Anthropic 原生可作为 `kind: 'anthropic'` 单独适配（消息格式不同，且浏览器直连有限制，优先在 Electron 用）。

## 8.3 流式解析（直连版）

保留现有解析逻辑，仅把请求目标从 `/api/cocreate` 换成 provider：

```ts
// packages/core/llm/stream.ts (要点)
const r = await fetch(`${p.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {})
  },
  body: JSON.stringify({
    model: p.model,
    temperature: 0.7,
    max_tokens: 512,
    stream: true,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userText }]
  })
})
// 解析 SSE data: 行 -> delta.content
// 复用原有：Qwen <think>…</think> 剥离、按 \n flush 成整行 bullet、拦截尾部 "SEARCH: <query>"
```

- 输出仍按「一次一个增量、只保留首条内容 bullet」的产品规则（对应现有 `App.tsx` 的 `stripMarker`/`isContentBullet` 与「保留第一条」逻辑）。

## 8.4 密钥存储

| 环境 | 存储 | 安全性 |
| --- | --- | --- |
| Electron | `safeStorage`（OS keychain 加密） | 高（推荐） |
| Web | IndexedDB（或 session-only） | 中，需明确风险提示 |

- key 只在客户端；绝不上传后端。
- 设置页支持多 Provider 管理与默认选择。

## 8.5 CORS 处理

| 场景 | 情况 | 对策 |
| --- | --- | --- |
| Groq / OpenAI / OpenRouter（Web） | 通常允许浏览器 CORS | 直接 fetch |
| Anthropic 原生（Web） | 浏览器直连受限 | 引导用 Electron，或 OpenAI 兼容网关 |
| Electron（任意 provider） | 无 CORS 限制 | 必要时主进程 fetch + IPC 回传（模块 11） |

## 8.6 Web 搜索（URL 卡片）

- 现状：`server/search.ts` 用我方 Tavily key。
- 初期：用户自配搜索 key，前端直连（保持「URL 卡片只来自真实搜索」约束）。
- 后期：做成带计费的后端可选服务（复用 STT 的记账模式）。

## 8.7 设置数据结构（示意）

```ts
interface LlmSettings {
  providers: LlmProvider[]
  activeProviderId: string
  webSearch: {
    enabled: boolean
    provider?: 'tavily' | 'exa' | 'brave'
    apiKey?: string
  }
}
```
