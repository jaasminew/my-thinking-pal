# 06 · STT 转发与录制状态

[← 返回索引](../technical-plan.md)

## 双路径

| 模式 | 实现 | 密钥 |
| --- | --- | --- |
| 本地-only | `SonioxSTT`（`services/stt/soniox.ts`）浏览器直连 | dev 编译期注入 / 设置 |
| `VITE_API_URL` 已设 | `BackendSTT`（`services/stt/backend.ts`）→ `GET /stt` | 服务端持 Soniox（或其它可插拔提供商） |

统一接口：`services/stt/types.ts` 的 `STTProvider`。音频：`pcm.ts` + `audio-source.ts`（麦克风 / 标签页）。

## 后端协议（要点）

上行：`{type:config}` + PCM16 二进制 + `{type:stop}`。下行：`transcript` / `error`。JWT 经 query 或握手前刷新。提供商可插拔（soniox / tencent / mock），见 `server-go/internal/stt`。

`BackendSTT` 状态：`connecting | live | reconnecting | error`（麦克风只启一次；重连换 token，有限次数）。

## 前端录制状态机（`Transcript.tsx`）

**CaptureState**（麦克风/链路对用户诚实）：

```text
idle → connecting → live → degraded → reconnecting → error
```

原则：任何失败路径不得让按钮仍显示「正在录」。另有 **EngineStatus**（转写结晶）：`idle | listening | extracting | organizing`，见 [10](10-transcript-and-cocreate.md)。

未登录但已配置后端时，UI 可阻止录音（需先登录才能走 `/stt`）。
