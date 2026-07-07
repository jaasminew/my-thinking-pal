# 11 · 桌面端 Electron

[← 返回索引](../technical-plan.md)

Electron 是可选但推荐的载体：解决 Web 版的 CORS/密钥安全短板，并提供更强的本地能力。`out/` 目录已有早期 Electron 构建产物，可据此重建。

## 11.1 目标

- 复用同一份 renderer（`packages/core` + `apps/web` 的 UI）。
- 提供更安全的密钥存储与无 CORS 的 MaaS 直连。
- 打包 macOS / Windows / Linux。

## 11.2 结构（electron-vite）

```text
apps/desktop/
  electron.vite.config.ts
  src/
    main/index.ts        主进程：窗口、safeStorage、IPC、可选 MaaS 代发
    preload/index.ts     contextBridge 暴露受限 API
    renderer/            引用 apps/web 或 packages/core 的 UI
  electron-builder.yml   打包配置
```

## 11.3 安全密钥存储

- 用 Electron `safeStorage.encryptString/decryptString`（底层 OS keychain）。
- 主进程持有加解密，preload 通过 `contextBridge` 暴露最小接口：

```ts
// preload
contextBridge.exposeInMainWorld('secureKeys', {
  get: (id: string) => ipcRenderer.invoke('keys:get', id),
  set: (id: string, value: string) => ipcRenderer.invoke('keys:set', id, value),
  list: () => ipcRenderer.invoke('keys:list')
})
```

- renderer 侧的 LLM 客户端（模块 08）优先从 `window.secureKeys` 取 key；Web 版回退到 IndexedDB。

## 11.4 绕过 CORS 的 MaaS 直连（可选）

- 对浏览器直连受限的 provider（如 Anthropic 原生），可在**主进程 fetch** 后 IPC 回传：

```ts
// main
ipcMain.handle('llm:stream', async (e, req) => { /* 主进程 fetch provider, 通过 event 回传 chunk */ })
```

- 默认仍走 renderer 直连；仅在需要时启用主进程代发。

## 11.5 可选：保留 CLI 路线给高级用户

- 现有 `server/agents.ts` 的 Claude/Codex CLI 复用订阅思路，可在 Electron **主进程**以本地子进程形式保留，作为「高级/离线」provider。
- 产品默认不启用；作为可选项，避免普通用户被本地 CLI 依赖困住。

## 11.6 本地持久化

- Electron 端 CRDT 用 `y-leveldb` 或文件，容量与性能优于浏览器 IndexedDB。

## 11.7 打包与更新

- `electron-builder` 产出安装包；配置代码签名（macOS notarization、Windows 签名）。
- 自动更新（`electron-updater`）列为后期。

## 11.9 实现现状（壳已落地）

已落地一个可运行的 Electron 壳（复用同一份 `apps/web` renderer，无需二次实现 UI）：

| 项 | 现状 | 位置 |
| --- | --- | --- |
| 主进程 | 创建窗口；dev 加载 `VITE_DEV_SERVER_URL`（默认 `http://localhost:5173`），打包后加载 `dist/index.html`；外链走系统浏览器 | `apps/desktop/main.cjs` |
| 安全密钥 | `safeStorage`（OS keychain）加密存储，落盘 `userData/secure-keys.json`；无 keychain 的平台回退明文并标记 | `apps/desktop/main.cjs`（`keys:get/set/delete/list` IPC） |
| preload | `contextBridge` 暴露 `window.secureKeys`（get/set/delete/list）与 `window.desktop.isElectron`；`contextIsolation: true`、`nodeIntegration: false` | `apps/desktop/preload.cjs` |
| renderer 集成 | LLM 客户端在 Electron 下优先从 `window.secureKeys` 取 key（Web 无此全局则 no-op）；保存 key 时镜像进 keychain | `services/llm/provider-config.ts`（`ensureSecureKeys` + `setProviderConfig` 镜像；单测 `provider-config.test.ts`） |
| 运行 | `npm run dev`（起 Vite）+ 另开一个 `npm run dev:desktop`（起 Electron） | `package.json` scripts |
| 打包 | `npm run build:desktop`（`vite build` + `electron-builder`）；产物 `apps/desktop/release/` | `apps/desktop/electron-builder.yml` |

**务实取舍**：main/preload 用 `.cjs`（仓库为 ESM，`.cjs` 规避 Electron ESM 入口的坑）。代码签名 / notarization / 自动更新（`electron-updater`）与 `y-leveldb` 本地大存储仍列为后期（11.6/11.7）；当前桌面端 CRDT 仍复用浏览器 IndexedDB。GUI 无法在受限沙箱内冒烟（Chromium 需系统调用），已通过版本核对 + 语法校验 + 全量单测/构建验证。

## 11.8 与 Web 版的差异对照

| 能力 | Web PWA | Electron |
| --- | --- | --- |
| 密钥存储 | IndexedDB（提示风险） | safeStorage（OS keychain） |
| MaaS CORS | 受个别 provider 限制 | 无限制（可主进程代发） |
| 本地存储容量 | 受浏览器配额 | 大（文件） |
| CLI provider | 不支持 | 可选支持 |
| 分发 | URL | 安装包 |
