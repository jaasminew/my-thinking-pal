# 01 · 系统架构

[← 返回索引](../technical-plan.md)

## 产品定位

Thinking Pal 是实时思考工作台（不是会议纪要工具）。AI 延展并结构化人类思考，不覆盖人类撰写内容；建议相邻、可区分、可 keep/reject；输出语言跟随用户主导口语。

## 一句话架构

- **客户端**（Web / Electron）：画布 UI、本地优先 Yjs CRDT、共创 / Observer / Command AI、转写结晶、可选登录与多设备同步。
- **Go 后端**（`VITE_API_URL` 启用）：账号、workspace/documents、CRDT 同步哑中继、STT 转发、鉴权搜索、托管 LLM、Project Memory 哑存储。
- **本地 Vite 中间件**（仅 `npm run dev`）：`/api/search`、`/api/url-meta`（及 desktop 用的 local-ai 相关路由）。

## 两种运行模式

| | `VITE_API_URL` 未设（本地-only） | 已设且已登录 |
| --- | --- | --- |
| 登录 / 多设备 | 无 | JWT + `/workspace` + 每 canvas `/sync/{docId}` |
| 画布持久化 | IndexedDB（Yjs） | 同上 + 云端快照/更新日志 |
| LLM | 前端直连 MaaS（BYOK / Groq 回退） | 有个人 key → 仍直连；否则 `POST /llm/chat/completions`（DeepSeek Flash/Pro） |
| 搜索 | Vite `/api/search` | Go `GET /search`（鉴权） |
| STT | 浏览器直连 Soniox | `BackendSTT` → Go `GET /stt` |
| Project Memory | IndexedDB 本地店 | 优先 Go `/project-memory/*` |

已设 `VITE_API_URL` 但未登录：可打开登录 UI；录音/云搜索等受阻，LLM 仍走客户端直连（非托管）。

## LLM 解析顺序

见 `services/llm/model-roles.ts`：

1. 用户 BYOK / Ollama / CLI Thinker 指派 → 客户端直连  
2. 已登录且无可用个人 key → 托管 DeepSeek（Listener=Flash，Thinker=Pro）  
3. 本地-only Groq 回退  
4. 否则报错  

托管时 base URL 为 `{apiBase}/llm`，`Authorization` 使用 access JWT；角色经 `X-Thinking-Pal-Role` 传递。

## 职责边界

```text
浏览器/Electron
  ├─ UI + SignalEngine（转写结晶）+ 共创/Observer/Command
  ├─ Yjs Board（packages/core/doc）+ IndexedDB
  ├─ LLM：直连 MaaS 或 → Go /llm
  └─ STT：Soniox 直连 或 → Go /stt

Go（可选）
  ├─ auth / documents / workspace
  ├─ /sync 哑中继（不解析 CRDT）
  ├─ /stt /search /url-meta /llm（持服务端 key）
  └─ /project-memory（哑存储；AI 在浏览器）

Vite dev relay
  └─ /api/search + /api/url-meta（本地-only）
```

## 关键路径

- 前端入口：`apps/web/src/{main,App,backend,AuthPanel}.tsx`
- CRDT：`packages/core/doc/*`、`apps/web/src/board-persistence.ts`
- 客户端库：`services/{api,sync,stt,llm,project-memory}/*`
- Dev relay：`server/{api-plugin,search,url-meta,proxy,local-ai}.ts`
- 后端：`server-go/`（路由见 [05](05-backend-go.md)）

上手运行见 [BUILD_AND_DEBUG.md](../BUILD_AND_DEBUG.md)。
