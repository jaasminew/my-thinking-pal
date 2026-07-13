# Thinking Pal 产品化技术方案（总览与索引）

> 目标：将现有 Vite 原型演进为一个可实际使用、前后端分离的产品。
> 定位：实时思考工作台（不是会议纪要工具）——帮助创作者在说话/倾听的同时保存并延展想法。

- 文档版本：v2（按模块拆分）
- 关键决策：**Go 后端** + **本地优先 CRDT 同步** + **LLM 前端直连 MaaS（用户自配 key）** + **co-thinking agent 跑在客户端**

---

## 一句话架构

- **客户端**（Web PWA / Electron）：画布 UI、本地优先 CRDT 文档与持久化、LLM 直连 MaaS、co-thinking agent、STT 采集与展示。
- **Go 后端**：账号体系、CRDT 同步中继与持久化、STT 转发（带账号识别与记账钩子）。
- **不经后端**：LLM 推理；**唯 Web 搜索 + og:image** 保留最小后端 relay（CORS/代理/我方 Tavily key）。
- 一句话：**声音 → 文字，走后端；文字 → 更多文字（agent/润色），走前端。**

> **进度（2026-07）**：Phase 0（LLM 前端直连 MaaS + 最小后端 relay + 下线 CLI）与 Phase 1（本地优先 Yjs CRDT，`packages/core/doc` + `y-indexeddb`）已落地并测试（详见 [01](modules/01-overview-and-decisions.md)、[04](modules/04-data-model.md)）。**Phase 2 后端已成形**：`server-go/` 已实现账号/JWT（argon2id + HS256）、**SQLite 持久化 AccountStore**（`modernc.org/sqlite`，重启不丢，内存实现供 dev/测试，契约测试保证等价）、documents CRUD、`/sync` 同步哑中继（内存 Hub + 文件 `DocStore` + 客户端快照压缩，[05](modules/05-sync-protocol.md)）、以及 `/stt` STT 转发（可插拔 soniox/tencent/mock，后端持 key，[07](modules/07-stt-forwarding.md)）。前端 provider 均已就绪并单测（`services/sync/board-sync.ts`、`services/stt/backend.ts`）。✅ **前端已接线**（`services/api` 客户端 + `apps/web/src/backend.ts` 的 `useBackend` + `AuthPanel`；登录后 `GET/PUT /workspace` 自动同步侧栏树，各 Idea Space 经内嵌 `docId` 挂 `BoardSync`→`/sync`，无 Documents 面板）：设 `VITE_API_URL` 即启用登录/多设备 Workspace 同步/后端 STT，未设则保持原「本地-only」体验（无登录、IndexedDB、浏览器直连 Soniox）。已过浏览器 E2E：注册→SQLite、workspace 树同步、`BoardSync`→`/sync`→落盘快照。✅ **Monorepo 目录已迁移**：前端 renderer 从 `canvas-cocreation/` 移至 `apps/web/`（Vite root 仍为仓库根，入口 `apps/web/src/main.tsx`）；`packages/core`（CRDT/LLM/设置）与 `services/*`（api/sync/stt/llm 共享客户端）经相对路径复用，`server/`（dev relay）与 `server-go/`（Go 后端）保持根级。✅ **dev 层 key 握手端点已下线**：`/api/soniox-key`、`/api/llm-config` 从 `server/api-plugin.ts` 移除（现仅剩 `/api/search` + `/api/url-meta`），改为编译期 dev 注入 `services/dev-keys.ts`（Vite `define` 的 `__DEV_LLM_KEYS__`，prod 为 `null`、经 dead-code 消除不打进包，已验证产物无泄漏 key）；消费方 `services/stt/soniox-key.ts`、`services/llm/provider-config.ts` 改读该注入，settings/keychain 优先、prod 静态构建优雅降级；登录态本就走 `/stt` 与设置面板，不依赖它们。✅ **Phase 3 Electron 壳已落地**（`apps/desktop`：`main.cjs` + `preload.cjs`，`safeStorage` keychain + 复用 `apps/web`，`electron-builder.yml` 打包；`npm run dev:desktop` / `build:desktop`；签名/notarization/自动更新与 `y-leveldb` 本地大存储列为后期，详见 [11](modules/11-desktop-electron.md)）。

---

> 上手运行/调试(三种模式、环境变量、测试、常见坑)见 [BUILD_AND_DEBUG.md](BUILD_AND_DEBUG.md)。

## 模块文档索引

| # | 模块 | 内容 | 文档 |
| --- | --- | --- | --- |
| 01 | 概览与决策 | 现状评估、两个核心决策与理由 | [modules/01-overview-and-decisions.md](modules/01-overview-and-decisions.md) |
| 02 | 系统架构 | 目标架构图、职责边界、部署拓扑 | [modules/02-architecture.md](modules/02-architecture.md) |
| 03 | 账号与鉴权 | 注册/登录/JWT/中间件 | [modules/03-auth-and-accounts.md](modules/03-auth-and-accounts.md) |
| 04 | 数据模型与存储 | CRDT 文档模型 + 双 Store 分离（MVP 嵌入式，无 PG） | [modules/04-data-model.md](modules/04-data-model.md) |
| 05 | 同步协议 | 哑中继同步、快照压缩、离线 | [modules/05-sync-protocol.md](modules/05-sync-protocol.md) |
| 06 | Go 后端 | 选型、目录、接口、部署 | [modules/06-backend-go.md](modules/06-backend-go.md) |
| 07 | STT 转发 | 实时流式转写、记账、防护 | [modules/07-stt-forwarding.md](modules/07-stt-forwarding.md) |
| 08 | LLM 客户端直连 | Provider 抽象、流解析、CORS/key | [modules/08-llm-client.md](modules/08-llm-client.md) |
| 09 | Co-thinking Agent | 触发、上下文、增量、反馈信号 | [modules/09-cothinking-agent.md](modules/09-cothinking-agent.md) |
| 10 | 前端画布与状态重构 | Yjs 绑定、临时态分离、渲染 | [modules/10-frontend-canvas.md](modules/10-frontend-canvas.md) |
| 11 | 桌面端 Electron | 打包、安全存储、主进程代发 | [modules/11-desktop-electron.md](modules/11-desktop-electron.md) |
| 12 | 路线图与安全 | 分阶段落地、安全、产品约束核对 | [modules/12-roadmap-and-security.md](modules/12-roadmap-and-security.md) |

---

## 建议仓库结构（Monorepo）

```text
apps/
  web/          React renderer ✅（已从 canvas-cocreation 迁入；Vite root=仓库根，入口 apps/web/src/main.tsx）
  desktop/      Electron 壳 ✅（main.cjs + preload.cjs：safeStorage 密钥 + 复用 apps/web；electron-builder.yml 打包；签名/更新后期）
packages/
  core/         CRDT schema / 类型 / agent / LLM 客户端（Web 与 Electron 共享）✅
services/       前端共享客户端库：api（auth/documents）、sync（BoardSync）、stt（BackendSTT/Soniox）、llm ✅
server/         dev-only 最小 relay（search + og:image），挂在 Vite dev 中间件
server-go/      Go 后端 ✅
docs/
  technical-plan.md   本索引
  modules/*.md        各模块设计
```

---

## 阅读顺序建议

1. 先读 01（决策）与 02（架构）建立全局认知。
2. 后端同学：03 → 04 → 05 → 06 → 07。
3. 前端同学：04（数据模型）→ 08 → 09 → 10 → 11。
4. 排期/评审：12。
