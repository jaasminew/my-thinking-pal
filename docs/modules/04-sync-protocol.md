# 04 · 同步协议

[← 返回索引](../technical-plan.md)

## 定位

Dumb relay：服务端**不解析** Yjs。已登录时每个 canvas 的 `docId` 对应 `GET /sync/{docId}`（WebSocket + `RequireAuth` + 文档归属校验）。

## 帧类型（客户端 `services/sync/board-sync.ts`）

| 码 | 名 | 行为 |
| --- | --- | --- |
| `0x03` | UPDATE | 二进制 Yjs update；服务端广播并 `AppendUpdate` |
| `0x04` | SNAPSHOT_PUT | 完整状态；服务端存快照并截断 update log |
| `0x05` | AWARENESS | 仅广播，不落盘 |

连接建立后客户端发送完整 `Y.encodeStateAsUpdate`。本地变更 → UPDATE；远端 UPDATE 以 `origin=provider` 应用，避免回声。

## 服务端（`server-go/internal/sync`）

- 入房：回放快照 + update log（均为 UPDATE 帧）。
- Hub：慢客户端（发送队列满）被踢；重连后靠快照/日志追赶。
- 前端默认 `snapshotDebounceMs: 15000` 压缩日志。

## 接线

`apps/web/src/backend.ts` + `App.tsx`：登录后为当前 space 的 `board.doc` 挂 `BoardSync`；URL 形如 `{ws}/sync/{docId}?token=…`，断线指数退避（上限约 15s）。未登录或未设 `VITE_API_URL` 时不挂同步。
