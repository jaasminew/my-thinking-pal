# 构建与调试指南

面向本仓库的三层结构:**Web 前端(`apps/web`)** + **可选 Go 后端(`server-go`)** + **可选桌面壳(`apps/desktop`)**。共享客户端库在 `packages/core`(CRDT/LLM/设置)与 `services/*`(api/sync/stt/llm)。

> 核心心智:**声音 → 文字,走后端;文字 → 更多文字(agent/润色),登录后默认可走托管 LLM,本地-only / BYOK 仍前端直连。** LLM 在本地-only 或用户自配 key 时直连 MaaS;登录且无个人 key 时走 Go `POST /llm/chat/completions`(DeepSeek Flash/Pro)。STT、搜索与跨设备同步走 Go 后端(登录后)。不配后端时一切退化为「本地-only」,零登录、IndexedDB 持久化、浏览器直连 Soniox。

---

## 1. 先决条件

- **Node** ≥ 18(建议 20+),npm
- **Go** ≥ 1.22(仅需后端时;当前用 1.24 开发)
- 可选:**Ollama**(本地开源模型实验);macOS 的 **Electron**(桌面壳,自动随 `npm install` 装好)

## 2. 一次性设置

```bash
npm install
cp .env.example .env    # 按需填 key,详见第 5 节
```

`.env` **不要提交**(已在 `.gitignore`)。

---

## 3. 运行模式

### A. 纯前端(本地-only,默认)

```bash
npm run dev            # Vite 起在 http://127.0.0.1:5173
```

- 无需登录;笔记存 IndexedDB(+ localStorage 镜像)。
- LLM key:`npm run dev` 下由**编译期注入**(`services/dev-keys.ts` 读 `.env`)自动带上;也可在 App 内「LLM 设置」弹窗手填。
- STT:浏览器直连 Soniox(需 `.env` 里的 `SONIOX_API_KEY`)。
- Web 搜索 / og:image:走 Vite dev 中间件 `server/api-plugin.ts` 的 `/api/search`、`/api/url-meta`(需 `TAVILY_API_KEY`)。

### B. 前端 + Go 后端(登录 / 跨设备同步 / 后端 STT / 搜索转发)

开两个终端:

```bash
# 终端 1:Go 后端(默认 :8080)
cd server-go
STT_PROVIDER=mock ACCOUNT_STORE=sqlite ACCOUNT_DSN="file:data/accounts.db" TAVILY_API_KEY=… make run

# 终端 2:前端指向后端
VITE_API_URL=http://127.0.0.1:8080 npm run dev
```

- 侧边栏出现 **Sign in**;登录后自动同步整份 Workspace：左侧树（项目 / 灵感空间）+ 每个画布的内容（`BoardSync` → `/sync`）。
- 第二台设备只需登录同一账号，侧栏树与画布内容会自动对齐；无需 Documents 面板或「Open here」。
- 登录后 Transcript 自动改用 `BackendSTT` 经后端 `/stt` 转发(key 只在后端)。
- 登录后 Web 搜索 / og:image 走 Go `GET /search`、`GET /url-meta`（`RequireAuth`，后端持 `TAVILY_API_KEY`）；未登录时搜索降级为空。
- 登录后 LLM 默认走 Go `POST /llm/chat/completions`（`RequireAuth`，后端持 `DEEPSEEK_API_KEY`；Listener=Flash，Thinker=Pro）。设置里填了个人 API key 则仍客户端直连。
- 真机 STT 用 `STT_PROVIDER=soniox` 并在后端设 `SONIOX_API_KEY`;`mock` 用于无 key 联调。

### C. 桌面壳(Electron)

```bash
npm run dev:desktop     # 起 Electron,加载 http://localhost:5173(需先跑 npm run dev)
npm run build:desktop   # 默认连接 https://mythinkingpal.xyz 的桌面包
npm run build:desktop:local # 本地-only 桌面包(未设置 VITE_API_URL)
npm run build:desktop:prod  # 显式生产桌面包
```

- 复用 `apps/web` 同一套 renderer(dev 读 Vite URL,打包读 `dist/index.html`)。
- 默认桌面包设置 `VITE_API_URL=https://mythinkingpal.xyz`;需要本地-only 时用 `build:desktop:local`。
- 桌面包是否连接后端由打包时的 `VITE_API_URL` 决定;未设置时保持本地-only。
- key 经 `safeStorage`(OS keychain)加密落盘,通过 preload 的 `secureKeys` 暴露给渲染进程;`provider-config.ts` 会优先从 keychain 补全空 key。

---

## 4. 测试

```bash
npm test                # 前端 + 共享库(Vitest),CI 用 run 模式
npm run test:watch      # 监听模式
npm run coverage        # packages/core 覆盖率

cd server-go && make test   # Go:go test ./...(含 /sync、/stt、存储契约测试)
cd server-go && make vet    # go vet
```

Vitest 用 `node` 环境;个别触碰 DOM 的用例用文件顶部 `// @vitest-environment jsdom` 声明。

## 5. 环境变量速查

### 前端(`.env`,Vite 读取)

| 变量 | 作用 |
| --- | --- |
| `GROQ_API_KEY` / `GROQ_MODEL` | 本地-only / BYOK 回退 LLM;dev 经编译期注入,prod 可用 App 内设置 |
| `CEREBRAS_API_KEY` / `CEREBRAS_MODEL` | 可选 LLM provider |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | 本地 Ollama(无 key、无代理) |
| `SONIOX_API_KEY` / `SONIOX_MODEL` | 浏览器直连 STT(本地模式) |
| `TAVILY_API_KEY` | 本地-only：Vite `/api/search`；生产 / 已登录：Go `/search` |
| `HTTPS_PROXY` | 仅 hosted API(Groq/Cerebras/Tavily/DeepSeek)在 CN 需要 |
| `VITE_API_URL` | 指向 Go 后端以开启登录/同步/后端 STT/搜索/托管 LLM;**留空 = 本地-only** |

> 生产构建中 `__DEV_LLM_KEYS__` 被替换为 `null` 并 dead-code 消除——**不会**把 `.env` 的 key 打进产物。

### Go 后端(`server-go`,进程环境变量)

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | 监听地址与端口 |
| `ACCOUNT_STORE` | `memory` | `memory`\|`sqlite`(生产用 sqlite) |
| `ACCOUNT_DSN` | `file:data/accounts.db?_journal=WAL` | sqlite 路径 |
| `DOC_STORE` / `DOC_PATH` | `fs` / `data/docs` | CRDT 更新日志 + 快照目录 |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | dev 占位 | **生产务必改** |
| `ACCESS_TTL` / `REFRESH_TTL` | `15m` / `720h` | token 有效期 |
| `STT_PROVIDER` | `soniox` | `soniox`\|`tencent`\|`mock` |
| `SONIOX_API_KEY` / `SONIOX_MODEL` | — / `stt-rt-v5` | Soniox 上游 |
| `TENCENT_APPID` / `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | — | 腾讯云 ASR(占位) |
| `TAVILY_API_KEY` | — | 登录态 `/search` Tavily 转发 |
| `DEEPSEEK_API_KEY` | — | 登录态 `/llm` DeepSeek 转发 |
| `DEEPSEEK_LISTENER_MODEL` / `DEEPSEEK_THINKER_MODEL` | `deepseek-v4-flash` / `deepseek-v4-pro` | 角色→模型 |
| `CORS_ORIGIN` | `*` | 允许的 Web 源 |

---

## 6. 生产构建

```bash
npm run build           # 前端 → dist/
npm run preview         # 本地预览 dist/
cd server-go && make build   # → server-go/bin/server
npm run build:desktop   # 生产桌面安装包 → apps/desktop/release/
```

`mythinkingpal.xyz` 的单机生产环境使用 Nginx + systemd，并由 GitHub Actions
在 `main` CI 成功后自动发布。首次服务器初始化、DNS/TLS、GitHub Environment、
备份恢复和回滚步骤见 [`deploy/README.md`](../deploy/README.md)。

桌面软件包不随服务器 CD 发布;创建 `v*` tag 时 `.github/workflows/desktop-release.yml`
会在 macOS、Windows、Linux 上分别打包,上传 Actions artifacts,并把安装包附加到
同名 GitHub Release。手动触发该 workflow 时必须指定已有 tag。

## 7. 调试技巧 & 常见坑

- **端口占用**:后端/前端换端口(`PORT=8097`、`vite --port 5188`);`lsof -ti tcp:PORT | xargs kill` 清残留。
- **本地 curl 探活挂住**:开发沙箱网络受限,`curl` 连本地端口务必加超时(`curl --max-time 4 http://localhost:PORT/healthz`),否则会一直阻塞。Vite 只绑 `localhost`(非 `127.0.0.1`),探活用 `localhost`。
- **CORS**:客户端直连 LLM / 访问后端时,后端 `CORS_ORIGIN` 需允许前端源(dev 用 `*`)。
- **WebSocket `/sync`、`/stt`**:后端已让日志中间件 `statusRecorder` 实现 `Hijack()`,否则升级会 501。
- **sqlite DSN**:`modernc.org/sqlite` 对 DSN 参数敏感;后端已在 `Open` 里净化 DSN、显式跑 PRAGMA(含 WAL)。
- **跨设备同步没接上**:登录后应自动 `GET /workspace` 拉侧栏树，并为每个 space 的 `docId` 挂上 `/sync`。若第二台设备仍是空树，检查是否已登录同一账号、后端 `GET /workspace` 是否返回非空 tree，以及浏览器是否拦了 WebSocket。
- **STT 无 key 报错**:本地模式需 `.env` 的 `SONIOX_API_KEY`;或登录用后端 `/stt`(`STT_PROVIDER=mock` 可无 key 联调)。
- **构建前自查**:改动交付前跑 `npm run build` + `npm test`(后端另跑 `make test`)。

## 8. 目录结构

```text
apps/web/          React renderer(Vite root 仍是仓库根,入口 apps/web/src/main.tsx)
apps/desktop/      Electron 壳(main.cjs / preload.cjs / electron-builder.yml)
packages/core/     共享:CRDT doc(schema/board)、LLM 解析、设置
services/          浏览器客户端库:api(auth/documents/workspace)、sync(BoardSync)、stt、llm、dev-keys
server/            dev 中间件 + 可独立构建的生产搜索/URL 元数据中继
server-go/         Go 后端:auth/JWT、documents、/sync 中继、/stt 转发(cmd + internal + Makefile)
docs/              技术方案与模块文档(见 technical-plan.md)
```

关键文件与行为详见 [`docs/technical-plan.md`](technical-plan.md) 与 [`AGENTS.md`](../AGENTS.md)。
