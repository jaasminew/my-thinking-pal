# 08 · 桌面端 Electron

[← 返回索引](../technical-plan.md)

## 现状

`apps/desktop/` 是薄壳，**复用** `apps/web` 渲染：

| 文件 | 作用 |
| --- | --- |
| `main.cjs` | 窗口、`safeStorage` 密钥 IPC、local-ai IPC |
| `preload.cjs` | 暴露 `secureKeys`、`desktop.isElectron`、`localAi` |
| `electron-builder.yml` | 打包配置 |

## 脚本

```bash
npm run dev            # Vite :5173
npm run dev:desktop    # VITE_DEV_SERVER_URL 加载上述地址
npm run build:desktop  # 默认 VITE_API_URL=https://mythinkingpal.xyz 后打包
npm run build:desktop:local
```

产物目录：`apps/desktop/release/`（gitignore）。

## 安全存储

IPC `keys:get|set|delete|list` → `userData/secure-keys.json`，优先 `safeStorage` 加密；无密钥链时明文回退。

## Local AI（可选）

主进程 IPC `local-ai:status|run|setup`，供设置面板中的 Codex / Claude Code 等本机 CLI 路径（与已删除的 `server/agents.ts` HTTP 路由无关）。Dev 下 Web 也可经 Vite `server/local-ai.ts` 走同类能力。Cursor CLI 在壳里可为 stub。

签名 / 公证 / 自动更新与更大本地存储（如 `y-leveldb`）仍属后续工作，不影响当前壳的可用性。
