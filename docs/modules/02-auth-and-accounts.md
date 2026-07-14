# 02 · 账号与鉴权

[← 返回索引](../technical-plan.md)

## 范围

仅在配置了 `VITE_API_URL` 时启用。实现位于 `server-go/internal/auth` + SQLite `AccountStore`；前端 `services/api` + `apps/web/src/{backend,AuthPanel}.tsx`。

## HTTP 路由

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| `POST` | `/auth/register` | 公开 |
| `POST` | `/auth/login` | 公开 |
| `POST` | `/auth/refresh` | 公开（body 带 refreshToken） |
| `POST` | `/auth/logout` | 公开（撤销 refresh；客户端先清本地） |
| `GET` | `/auth/me`、`GET /me` | Bearer |

密码：argon2id。Access JWT 默认 TTL **15m**（`ACCESS_TTL`）；Refresh 默认 **720h**（`REFRESH_TTL`），服务端存 hash，**刷新时轮换**（旧 refresh 立即失效）。

Token 拾取：`Authorization: Bearer`；WebSocket 可用 query `?token=` 或 subprotocol `bearer,<token>`。

## 前端行为

- Token 存 `localStorage`（`tp.auth.access|refresh|user`），见 `services/api/tokens.ts`。
- `authedFetch`：遇 401 则去重刷新一次再重试；失败则清会话。
- WebSocket（`/sync`、`/stt`）握手前可调用 `refreshSession()` 换新 access。
- `useBackend()`（`backend.ts`）暴露 session、documents/workspace 映射、sync/stt URL。

## 与其它模块

登录后：workspace 树经 `GET/PUT /workspace` 同步；每个 Idea Space 的 `docId` 挂 `BoardSync` → [04](04-sync-protocol.md)；STT/搜索/托管 LLM/Project Memory 均走 `RequireAuth`。
