# 06 · Go 后端

[← 返回索引](../technical-plan.md)

后端只承担三件事：**账号体系**、**CRDT 同步中继与持久化**、**STT 转发**。刻意保持轻量、无状态优先。

## 6.1 技术选型

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 语言 | Go | 单二进制、部署轻、并发强、适合大量 WS 长连接与 STT 转发 |
| 路由 | chi（推荐）/ gin | chi 贴近 `net/http`，中间件清晰 |
| WebSocket | nhooyr.io/websocket / gorilla/websocket | 前者 API 现代、context 友好 |
| 账号存储 | MVP：SQLite（`modernc.org/sqlite` 纯 Go，免 CGO）→ 后期 pgx/Postgres | 小、事务、低写入；嵌入式零运维 |
| CRDT 存储 | MVP：文件系统（默认，最省）→ BadgerDB（`dgraph-io/badger`）→ 后期对象存储 | blob、高写入；与账号分离（阶梯见模块 04） |
| 迁移 | goose / golang-migrate（SQLite 与 PG 通用） | SQL 迁移管理 |
| 密码 | argon2id（`golang.org/x/crypto/argon2`） | 抗暴力 |
| JWT | golang-jwt/jwt | 成熟 |
| 配置 | env + `caarlos0/env` 或 viper | 12-factor |
| 日志 | slog（标准库） | 结构化 |

## 6.2 目录结构

```text
server-go/
  cmd/server/main.go            组装依赖、启动 HTTP/WS
  internal/
    config/config.go            读取 env
    auth/
      handler.go                register/login/refresh/logout/me
      jwt.go                     签发/校验
      password.go               argon2id
      middleware.go             RequireAuth
    documents/
      handler.go                list/create/delete
      repo.go
    sync/
      hub.go                    每 docId 的连接集合 + 广播（内存热路径）
      ws.go                     /sync/:docId 握手与消息循环
    stt/
      ws.go                     /stt 握手
      upstream.go               连接 Deepgram 等上游
      meter.go                  用量记账钩子
    storage/
      account_store.go          AccountStore 接口
      doc_store.go              DocStore 接口
      sqlite/                   AccountStore 的 SQLite 实现（MVP）
      badger/                   DocStore 的 BadgerDB 实现（MVP）
      postgres/                 AccountStore 的 PG 实现（后期）
      objstore/                 DocStore 的 S3/MinIO 实现（后期）
  migrations/                   *.sql（账号侧，SQLite/PG 通用）
  Dockerfile
  Makefile
```

- 两个存储接口（`AccountStore` / `DocStore`，定义见模块 04）各有 MVP 与规模化实现，业务代码只依赖接口。

## 6.3 路由总表

```text
# 健康
GET    /healthz                          -> 200

# 账号（模块 03）
POST   /auth/register
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
GET    /me                    (auth)

# 文档
GET    /documents             (auth)     -> [{ id, title, updatedAt }]
POST   /documents             (auth)     { title } -> { id }
PATCH  /documents/:id         (auth)     { title }
DELETE /documents/:id         (auth)

# 同步（模块 05，WebSocket）
GET    /sync/:docId           (auth)

# STT（模块 07，WebSocket）
GET    /stt                   (auth)

# 可选（后期）：带计费的搜索转发
GET    /search?q=...          (auth)
```

## 6.4 同步 Hub 骨架（示意）

```go
type Hub struct {
    mu    sync.RWMutex
    rooms map[string]map[*Conn]struct{} // docId -> conns
}

func (h *Hub) Join(docID string, c *Conn) { /* 加入房间 */ }
func (h *Hub) Leave(docID string, c *Conn) { /* 离开房间 */ }

func (h *Hub) Broadcast(docID string, from *Conn, msg []byte) {
    h.mu.RLock()
    defer h.mu.RUnlock()
    for c := range h.rooms[docID] {
        if c != from {
            c.Send(msg) // 非阻塞写队列
        }
    }
}

// 消息循环：收到 UPDATE -> 持久化 + 广播
func (s *SyncServer) handle(c *Conn) {
    for {
        typ, data, err := c.Read()
        if err != nil { break }
        switch typ {
        case MsgUpdate:
            // 热路径：先广播（内存），持久化可异步/批量，不阻塞协作
            s.hub.Broadcast(c.docID, c, frame(MsgUpdate, data))
            s.docStore.AppendUpdate(ctx, c.docID, data) // DocStore（Badger/FS）
        case MsgSnapshotPut:
            s.docStore.PutSnapshot(ctx, c.docID, snap, sv, ver) // + 截断旧 update
        case MsgAwareness:
            s.hub.Broadcast(c.docID, c, frame(MsgAwareness, data)) // 不持久化
        }
    }
}
```

## 6.5 配置（env）

```text
PORT=8080

# 存储（MVP：嵌入式，无外部 DB）
ACCOUNT_STORE=sqlite            # sqlite | postgres
ACCOUNT_DSN=file:data/accounts.db?_journal=WAL
DOC_STORE=fs                    # fs（最省，默认）| badger | postgres | s3
DOC_PATH=data/docs              # fs 根目录 / badger 目录

# 鉴权
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
ACCESS_TTL=15m
REFRESH_TTL=720h

# STT 上游（模块 07，后端持 key，可插拔）
STT_PROVIDER=soniox             # soniox | tencent | mock
SONIOX_API_KEY=...
SONIOX_MODEL=stt-rt-v5
# TENCENT_APPID= / TENCENT_SECRET_ID= / TENCENT_SECRET_KEY=（STT_PROVIDER=tencent 时）

# --- 规模化时才需要（后期） ---
# ACCOUNT_STORE=postgres
# ACCOUNT_DSN=postgres://user:pass@host:5432/thinkingpal
# DOC_STORE=s3
# OBJECT_STORE_ENDPOINT=
# OBJECT_STORE_BUCKET=
```

## 6.6 部署

- 交付物：单一静态二进制 + `migrations/`；MVP 无外部 DB 依赖。
- 持久化目录（`data/accounts.db`、`data/docs`）挂成持久卷，勿随容器销毁。
- 容器化：多阶段 `Dockerfile`（`golang:alpine` 构建 → `distroless`/`alpine` 运行）；SQLite 用纯 Go 驱动可免 CGO。
- 启动时执行账号侧迁移（或独立迁移步骤）；`DocStore` 无需迁移（KV/文件）。
- 反向代理需支持 **WebSocket 升级**与长连接（`proxy_read_timeout` 调大）。
- 健康检查 `GET /healthz`；优雅关闭（关 WS、drain）。

## 6.7 可观测性

- 结构化日志（slog）：请求、WS 连接生命周期、上游 STT 错误。
- 指标（后期）：活跃 WS 连接数、同步广播吞吐、STT 时长（同时喂 `usage_events`）。

## 6.8 实现现状（后端已成形）

`server-go/` 已按接口分层落地，与 6.1 选型表有几处**务实取舍**：

| 关注点 | 计划 | 实际 | 说明 |
| --- | --- | --- | --- |
| 路由 | chi/gin | **标准库 `net/http` ServeMux**（Go 1.22 方法+路径模式） | 零依赖够用；`internal/httpapi/router.go` 内含 cors/logging 中间件 |
| WebSocket | nhooyr.io/websocket | **`github.com/coder/websocket`**（nhooyr 的社区续维版） | API 一致、context 友好 |
| 账号存储 | SQLite（modernc）✅ | **已实现** `internal/storage/sqlite`（+ 内存实现供 dev/测试） | `ACCOUNT_STORE=sqlite\|memory`；重启不丢 |
| CRDT 存储 | 文件系统 ✅ | **已实现** `internal/storage/fsdoc` | `upd/<seq>.bin` + `snapshot.bin`（模块 05） |
| 迁移 | goose/golang-migrate | **暂用 `CREATE TABLE IF NOT EXISTS` 内嵌 schema** | MVP 够用，SQL 保持 PG 可移植；表变复杂再引入迁移工具 |
| JWT | golang-jwt | **标准库自实现 HS256**（`internal/auth/jwt.go`） | 无第三方依赖，含 `jti` 保证唯一 |
| 配置 | caarlos0/env / viper | **标准库 `os.Getenv` + 默认值**（`internal/config`） | 12-factor，零依赖 |

- 存储契约测试 `internal/storage/storagetest`：同一套 `RunAccountStoreContract` 同时校验 memory 与 sqlite，保证行为等价；`sqlite_test.go` 另测重启持久化与 `file:...?params` DSN。
- 当前依赖仅：`coder/websocket`、`golang.org/x/crypto`（argon2id）、`modernc.org/sqlite`（纯 Go 免 CGO）。
- 目录与 6.2 略有出入：`documents/handler.go` 直接依赖 `AccountStore`（尚无独立 `repo.go`）；`stt/` 为 `upstream.go`/`soniox.go`/`tencent.go`/`mock.go`/`handler.go`（记账钩子在 `handler.go` 内的 `recordUsage`/`checkQuota`）。
