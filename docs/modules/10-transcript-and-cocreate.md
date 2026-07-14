# 10 · 转写与共创机制

[← 返回索引](../technical-plan.md)

## 目标

1. **转写结晶**：原始 STT 口语不直接当笔记展示；经 SignalEngine 变成带标题的分层文稿。  
2. **画布共创**：AI 在旁补充想法（详见 [07](07-cothinking-agent.md)）。

## 转写双层节奏（当前实现）

实现：`apps/web/src/signal-engine.ts`（由 `Transcript.tsx` 驱动）。**不是**旧的 30s cleanup / 2min segmentation。

| 阶段 | 周期 | 作用 |
| --- | --- | --- |
| Extract | 默认 **2 min**（`extractIntervalMs`） | 原始语音 → 质量过滤后的 pending 信号行，写入开放 `tail` |
| Organize | 默认 **5 min** + 停止时（`organizeIntervalMs`） | 将 pending 归并/成组为带标题的 **frozen** section；用户改过的行不再被模型改写 |

引擎状态：`idle → listening → extracting → organizing`。

LLM：`services/llm/client.ts` → `requestExtractSignals` / `requestOrganize`（走与全局相同的直连或托管传输）。

## 持久化与同步

`frozen` + `tail` 写入 Board 的 `transcript` Y.Map（`getTranscript` / `setTranscript`），登录后随 [04](04-sync-protocol.md) 多设备一致。

## STT 输入

本地-only：浏览器 Soniox。登录后端：`BackendSTT` → `/stt`。录制 UI 状态机见 [06](06-stt-forwarding.md)。

## 与画布的交互

- 可从转写拖短语到画布成笔记。  
- 空白画布点击建笔记。  
- 共创 / Observer / Command 在笔记上追加 pending AI 内容，keep/reject 规则见 [07](07-cothinking-agent.md)。  
- URL 卡片仅来自真实搜索结果。

## 相关文件

- `apps/web/src/{Transcript,signal-engine}.tsx|ts`
- `services/stt/*`、`services/llm/{client,cocreate,observer,command-chat,llm-transport}.ts`
- `packages/core/llm/*`（prompt 与解析）
