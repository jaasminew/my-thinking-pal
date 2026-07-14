# 09 · Project Memory

[← 返回索引](../technical-plan.md)

## 设计

服务端是**哑存储**：不调用 AI、不持 LLM key。标题/描述、Stage-A 选文件、检索装配均在浏览器用用户当前 LLM 设置完成。共享类型：`shared-contract/project-memory.ts`（`services/project-memory/types.ts` 再导出）。

## 作用域

`project` | `space`（侧栏树在客户端；canvas 在 project 下则用 project scope，否则 space scope）。指令可两级合并：`mergeInstructions(project, canvas)`（canvas 后写，具体覆盖笼统）。

## 客户端

| 模式 | 存储 |
| --- | --- |
| 本地-only / 未登录 | `createLocalStore`（IndexedDB） |
| 已登录 | `createMemoryClient` 优先打 Go API |

关键：`services/project-memory/{client,local-store,ingestion,ingestion-pdf,retrieve,describe,vision,scope}.ts`；UI：`use-project-memory.ts`、`ProjectMemoryModal.tsx`。

检索产出 `ProjectMemoryContext`（格式化 `block` + 可选图片 data URL），挂到共创/命令等请求。

## 服务端 DDL（SQLite）

表：`project_memory_files`、`project_memory_texts`、`project_memory_instructions`（见 `server-go/internal/storage/sqlite`）。Blob 磁盘路径：`<dataDir>/project-memory/<owner_id>/<file_id>`。上传上限 **20MB**；正文上限约 **250k** 字符。

上传：浏览器可先抽文本（txt/md 等）经 multipart 提交；否则服务端对 PDF/Office 做确定性抽取。成功 `indexed`，失败保留 blob 并 `failed`。无 embedding / chunk 表。

## 路由（均需鉴权；按 `owner_id` 隔离）

| 方法 | 路径 |
| --- | --- |
| GET/POST | `/project-memory/{scopeKind}/{scopeId}/files` |
| DELETE | `/project-memory/files/{id}` |
| GET | `/project-memory/files/{id}/text`、`…/blob` |
| GET/PUT | `/project-memory/{scopeKind}/{scopeId}/instructions` |
| DELETE | `/project-memory/{scopeKind}/{scopeId}` |

实现：`server-go/internal/projectmemory/`。
