# 05 · Go 后端

[← 返回索引](../technical-plan.md)

## 角色

可选产品后端（`server-go/`）。前端用构建期 `VITE_API_URL` 指向它。本地-only 不依赖本进程。

目录要点：`cmd/server`、`internal/{httpapi,auth,documents,workspace,sync,stt,search,llm,projectmemory,storage,config}`。

## 路由一览（`internal/httpapi/router.go`）

| 区域 | 路由 |
| --- | --- |
| 健康 | `GET /healthz` |
| 鉴权 | `POST /auth/register\|login\|refresh\|logout`；`GET /auth/me`、`GET /me` |
| 文档 | `GET/POST /documents`；`PATCH/DELETE /documents/{id}` |
| Workspace | `GET/PUT /workspace` |
| 同步 | `GET /sync/{docId}`（WS） |
| STT | `GET /stt`（WS） |
| 搜索 | `GET /search`；`GET /url-meta` |
| LLM | `POST /llm/chat/completions` |
| Project Memory | `GET/POST /project-memory/{scopeKind}/{scopeId}/files`；`DELETE /project-memory/files/{id}`；`GET …/files/{id}/text`；`GET …/files/{id}/blob`；`GET/PUT …/instructions`；`DELETE /project-memory/{scopeKind}/{scopeId}` |

除 `healthz` 与公开 auth 外均 `RequireAuth`。CORS 允许 `Authorization`、`Content-Type`、`X-Thinking-Pal-Role`。

## 环境变量（常用）

只写变量名，不写真实值或生产机 IP。

- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`、`ACCESS_TTL`、`REFRESH_TTL`
- `ACCOUNT_STORE=sqlite|memory`；SQLite 数据目录默认相对 `data/`
- `SONIOX_API_KEY` / STT 提供商；`TAVILY_API_KEY`
- `DEEPSEEK_API_KEY`、`DEEPSEEK_LISTENER_MODEL`、`DEEPSEEK_THINKER_MODEL`
- `HTTPS_PROXY`（出站 Tavily/DeepSeek）
- `HOST` / `PORT`（默认本机回环，见 `deploy/env/api.env.example`）

部署见 [`deploy/README.md`](../../deploy/README.md)。测试：`cd server-go && make test`。

## 与前端

`services/api/*`（HTTP）、`services/sync/board-sync.ts`、`services/stt/backend.ts`、`services/llm/llm-transport.ts`、`services/project-memory/client.ts`。
