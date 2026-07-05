# 03 · 账号与鉴权

[← 返回索引](../technical-plan.md)

账号体系是同步与 STT 转发的前提：同步需要按 `owner_id` 隔离文档，STT 转发需要按账号识别以支撑未来计费/限流。

## 3.1 认证模型

- 主认证：**邮箱 + 密码**（密码用 `argon2id` 哈希）。
- 令牌：**JWT access token（短时，如 15min）** + **refresh token（长时，如 30d，可撤销）**。
- access token 同时用于 REST 与 WebSocket 鉴权。
- OAuth（Google 等）列为后期扩展，不阻塞首版。

## 3.2 接口

```text
POST /auth/register   { email, password }        -> { accessToken, refreshToken, user }
POST /auth/login      { email, password }        -> { accessToken, refreshToken, user }
POST /auth/refresh    { refreshToken }           -> { accessToken }
POST /auth/logout     { refreshToken }           -> 204   (撤销该 refresh token)
GET  /me              (Bearer)                    -> { id, email, createdAt }
```

## 3.3 JWT Claims

```json
{
  "sub": "<user_uuid>",
  "email": "user@example.com",
  "iat": 1700000000,
  "exp": 1700000900,
  "typ": "access"
}
```

- access 与 refresh 用不同 `typ` 区分；refresh 额外在 DB 存 `token_hash` 以支持撤销。

## 3.4 WebSocket 鉴权

WS 无法自定义 Header 时，采用以下任一：

1. **Subprotocol 传令牌**：`Sec-WebSocket-Protocol: bearer,<accessToken>`（推荐，Electron/浏览器均可）。
2. **查询参数**：`/sync/:docId?token=<accessToken>`（简单，但令牌可能进日志，需注意）。

握手时校验令牌 → 解析 `sub` → 后续按 `sub` 做归属校验。

## 3.5 Go 中间件（示意）

```go
func RequireAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tok := bearerFromHeader(r) // 或 subprotocol / query
        claims, err := jwt.VerifyAccess(tok)
        if err != nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        ctx := context.WithValue(r.Context(), userIDKey, claims.Sub)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

## 3.6 相关表

见模块 04：`users`、`refresh_tokens`。

## 3.7 安全要点

- 密码策略 + 登录失败限速（防撞库）。
- refresh token 轮换（rotation）+ 复用检测（被盗用即全撤销）。
- 所有令牌走 HTTPS/WSS。
- 邮箱验证与找回密码列为后期。
