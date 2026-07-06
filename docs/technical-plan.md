# Thinking Pal 产品化技术方案（总览与索引）

> 目标：将现有 Vite 原型演进为一个可实际使用、前后端分离的产品。
> 定位：实时思考工作台（不是会议纪要工具）——帮助创作者在说话/倾听的同时保存并延展想法。

- 文档版本：v2（按模块拆分）
- 关键决策：**Go 后端** + **本地优先 CRDT 同步** + **LLM 前端直连 MaaS（用户自配 key）** + **co-thinking agent 跑在客户端**

---

## 一句话架构

- **客户端**（Web PWA / Electron）：画布 UI、本地优先 CRDT 文档与持久化、LLM 直连 MaaS、co-thinking agent、STT 采集与展示。
- **Go 后端**：账号体系、CRDT 同步中继与持久化、STT 转发（带账号识别与记账钩子）。
- **不经后端**：LLM 推理、（初期）Web 搜索。
- 一句话：**声音 → 文字，走后端；文字 → 更多文字（agent/润色），走前端。**

---

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
  web/          React renderer（由 canvas-cocreation 演进）
  desktop/      Electron 壳（electron-vite）
packages/
  core/         CRDT schema / 类型 / agent / LLM 客户端（Web 与 Electron 共享）
server-go/      Go 后端
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
