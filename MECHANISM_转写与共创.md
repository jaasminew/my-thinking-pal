# My Thinking Pal — 转写与共创机制说明

_面向工程伙伴的技术文档。基于 `integrate-transcript` 分支当前实现。_

本文解释两个核心机制：

1. **实时转写（Transcription）** —— 把说话人的口语，实时结晶为一份结构化、有层级的思考笔记。
2. **画布共创（Co-Creation）** —— AI 作为环境中的共创伙伴，在用户思考的旁边补充、而非改写用户的想法。

---

## 一、整体架构

原型用一个 Vite 进程同时承担前端与本地 API 路由（`server/api-plugin.ts`），刻意保持简单：

- **浏览器永远不直接持有模型密钥**（仅本地原型的 STT key 端点例外，生产要换成临时 token 签发）。
- 所有模型调用都走 `/api/*` 后端路由，密钥只存在于服务端。
- 涉及中国网络时，服务端统一走本地代理（`HTTPS_PROXY` / `AGENT_PROXY`）。

两个机制的公共契约：

- STT 提供商实现统一接口 `STTProvider`（`services/stt/types.ts`），换供应商不动 UI。
- LLM 调用统一走 `services/llm/*` 客户端 → `/api/*` 服务端。

---

## 二、实时转写机制

### 2.1 分层设计的核心思想

转写不是"把语音变成文字"这么简单。原始 STT 文本**从不直接展示**给用户——它太碎、太口语、带口水词。真正呈现的是一份**逐步结晶的书面化笔记**。

实现上把"即时清洗"和"异步结构化"**解耦**成两个独立的节奏（`canvas-cocreation/src/cleanup-engine.ts`）：

```
原始语音
  → [STT 层] 实时逐字转写（隐藏，不展示）
  → [Cleanup 每 30s] 把这段口语改写成书面化的"一行一想法"，追加到开放的 tail
  → [Segmentation 每 2min] 思考模型判断话题在哪里切换，冻结成带标题的 section
```

### 2.2 STT 层：Soniox 实时多语言转写

首选 Soniox（`services/stt/soniox.ts`），因为它能处理**中英混说（code-switching）**——逐 token 自动识别语言，这是 WebSpeech（单语言）和 Deepgram（中文弱）做不到的。

技术细节：

- 浏览器用 `AudioContext` + `ScriptProcessorNode` 采集音频。
- 从系统采样率（通常 48kHz）**线性降采样到 16kHz**，转成 PCM16。
- 通过 WebSocket 把裸 PCM 流推给 `wss://stt-rt.soniox.com`。
- 首帧发 JSON 配置：`enable_language_identification: true` + `language_hints: ['en', 'zh']`。
- 回传的 token 分两类：`is_final` 的 → 永久 chunk（`isFinal: true`）；其余 → 实时假设（interim）。

STT 事件契约（`TranscriptEvent`）非常薄，只有 `text` / `isFinal` / `timestamp`，所以底层可以随时替换成 Deepgram、Speechmatics、讯飞、Gemini Live 等（仓库里都有适配器）。

**关键行为**：`pushInterim()` 是空实现——interim 假设文本**故意被丢弃**，永远不进入展示层。只有 final chunk 进入清洗缓冲区。

### 2.3 第一层：Cleanup（清洗，每 30s）

`CleanupEngine.runCleanup()`：

1. 把 30s 内累积的原始 final 文本（`pendingRaw`）快照出来，**立刻清空缓冲区**——保证同一段原文不会被清洗两次。
2. 调 `/api/clean-transcript`，把 raw 交给快速模型（默认 `gpt-oss-20b`）。
3. 服务端提示词要求：**只清洗新说的话**，改写成书面化、"一行一个完整想法"，丢弃口水词和跑题，**匹配用户主导语言**（中文为主就写中文），不加任何 Markdown。
4. 已有的 tail 文本作为**只读上下文**传进去（`existingNotes`），让模型知道不要重复，但不许改写。
5. 返回的每一行拆成一个 `Line`（带时间戳），追加到 `tail`。

容错设计：

- 空窗口静默跳过，**从不报错**。
- 模型出错或返回空 → 把 raw **放回缓冲区**，下一个 tick 重试，用户无感知（语音绝不丢失）。
- `isMeaningfulChunk()` 门槛：拉丁词数或中文字数不够就先不发，避免把零碎片段送进模型。
- `gen` 版本号：reset 时自增，防止迟到的异步结果写入过期状态。

### 2.4 第二层：Segmentation（结构化，每 2min + 停止时）

`CleanupEngine.runSegment()`：

1. 把当前 `tail`（还没冻结的部分）编号后发给**思考模型**（默认 `gpt-oss-120b`，开启 hidden reasoning）。
2. 只发 tail，**已冻结的 section 不再发送**——所以已冻结的部分永不抖动。
3. 服务端（`/api/segment`）用严格 JSON 契约返回话题边界：

```json
{ "sections": [ { "endLine": 2, "header": "..." }, { "endLine": 6, "header": "..." } ] }
```

4. `applySegments()` 把 `[0..2]`、`[3..6]` 各冻结成一个带标题的 section，最后一个 `endLine` 之后的行仍保留为开放 tail。

设计要点：

- **一行 = 一个想法** 是分割的原子单位，所以哪怕话题切换发生在同一个 30s cleanup 块**内部**，也能被切开。
- **冻结即最终**：section 一旦冻结，模型永不再碰，布局不闪烁。用户仍可手动编辑任何行/标题（append-only，模型不覆盖用户编辑）。
- 常规 pass **留下最后一个进行中的话题不切**（`closing: false`）；停止录制时跑一次 `closing: true` 的收尾 pass，把剩余 tail 也命名冻结，保证没有无标题段落。

段落结构化模型的**三重"不出错"保证**：

1. 结构上——输出是被**解析**的 JSON，不是打印的文本，泄漏的 reasoning 到不了 UI。
2. 配置上——`reasoning_format: 'hidden'` + 充足 `max_tokens`，保证 JSON 不被 reasoning 挤没。
3. 兜底——解析失败/为空 → 当作"本轮不切"，静默重试。

### 2.5 状态机

引擎向 UI 抛四个状态：`idle` → `listening`（累积中）→ `summarizing`（cleanup 进行中）→ `organizing`（segmentation 进行中）。

---

## 三、画布共创机制

### 3.1 核心定位

AI 是 keyword note（画布上的一个笔记块）里的**环境（ambient）共创伙伴**。原则：

- **在用户思考旁边补充，永不改写用户的文字**（append-only）。
- **PASS 是合法答案**——顺畅流动的笔记需要沉默，不是装饰。
- 设计哲学是"苦涩的教训"（bitter lesson）：**用模型判断，而不是人手写的动作菜单**。

### 3.2 三个可切换后端

统一走 `/api/cocreate`，浏览器完全不知道背后是谁（`services/llm/cocreate-types.ts`）：

| provider | 走什么 | 说明 |
|---|---|---|
| `claude-code` | 本地 `claude` CLI（headless） | 走**订阅**而非按量付费 API key；WebSearch 内置 |
| `codex` | 本地 `codex` CLI | 走 ChatGPT 订阅 |
| `open` | OpenAI 兼容模型（Groq / Cerebras / Ollama）+ Tavily 搜索 | |

CLI 路由通过 `spawn` 子进程（`server/agents.ts`），以 `stream-json` / JSONL 输出，服务端逐行解析出 token delta 和搜索结果 URL。

### 3.3 "先诊断，后贡献"协议（Diagnose-then-Contribute）

这是共创质量的核心（`COCREATE_SYSTEM` 提示词）。模型被强制分两步：

**STEP 1 — DIAGNOSE**：先找出笔记里**此刻最需要外部输入的那一个点**（一个没有支撑的论断、一个需要真实案例的空泛想法、一个卡住需要新方向的思路、一个值得挑战的隐含假设、一条被用户丢掉但有价值的 transcript 线索……），判断"哪种贡献、多少量"最适合这个点。

**STEP 2 — CONTRIBUTE**：产出正好那个东西，且**锚定在真实、有名有姓的东西上**（一个产品、项目、论文、事件），并用一句话说清"它是怎么做到的"。有依据的 bullet 胜过聪明但无锚点的 bullet。

严格输出格式：

```
DIAGNOSIS: <一行——哪个点 + 它需要什么>   ← 机器读，永不展示
ANCHOR: <n>  或  ANCHOR: NONE            ← 机器读，永不展示
然后 EITHER 单独一行 "PASS"  OR  1-3 条 "- " 开头的 bullet（每条 ≤ 25 词）
```

服务端 `makeProtocolFilter()` 按整行拦截这个协议：

- `DIAGNOSIS:` 行 → 抽成独立的 `diagnosis` NDJSON 事件，**不作为文本展示**。
- `ANCHOR: <n>` 行 → 抽成 `anchor` 事件，告诉前端这条贡献挂在用户第 n 条 bullet 下面（放成子点，而不是笔记末尾）。
- `PASS` 行 → 抑制，本次不贡献任何内容。
- 其余行 → 正常作为文本流出。

**为什么 DIAGNOSIS 要被强制说出来**：它是机器读的，前端把它**隐形地**存下来，并给用户 kept/rejected 的每条建议打上这个诊断标签——这样用户的反应就能教会模型"哪种帮助有用"，而不只是"哪段文字有用"。

### 3.4 触发时机

环境 fire 的触发条件（`App.tsx` 的 trigger effect）：

> **每当某个 note 的人类字数增长 20，且该 note 已经 ≥5 秒没有敲键，就触发一次。**

- **字数增长 20** → 说明有足够的新想法值得反应。
- **5 秒 idle 等待** → 避免 AI 内容在用户正在打字时冒出来抢注意力。
- 只在**当前激活的画布**上触发（`isActiveRef`）。
- AI 开关关闭时，取消所有进行中的环境 fire（command 类型的除外，让它跑完）。
- 重新打开 AI 时，把每个 note 的基线重置为**当前字数**——避免关闭期间写的内容一开就爆发一堆过时建议。

### 3.5 上下文工程（Context Engineering）

`buildCocreateContext()` 发给模型的上下文——这是 Jasmine 调优的旋钮，刻意保持精简：

- **transcriptWindow**：逐字（非清洗版）的 transcript 窗口。拖拽关键词来的 note 用"关键词被说出前后 ±1min"，其他 note 用"滚动的最近 2min"。
- **contextNotes**：该 note 里用户已写的 bullet，**编号**（这样模型能用 ANCHOR 指定挂在第几条），缩进表示大纲层级。
- **kept / rejected**：用户保留（正向）/ 拒绝（负向）过的 AI 建议，每条可能带 `[offered because: …]` 诊断标签。
- **existingIdeas**：画布上已有的一切（人类 + AI bullet、卡片标题）——明确要求"不要重复"。
- **seedText**：用户当前的焦点（一个手打的粗糙想法，或拖上来的 transcript 短语）。

只有**被用户保留（kept）的永久 AI 内容**才作为下一次调用的上下文；pending（待定）的建议是临时的、可能被拒，所以不计入。

### 3.6 反应学习闭环

- **保留（keep）**：把该 bullet/卡片连同其诊断塞进 `note.kept`。
- **拒绝（reject）**：塞进 `note.rejected`；同时记录被拒的 fireLine，让还在流式输出的同一次 fire 不能把这条重新画出来。
- 下一次 fire 时，`kept` / `rejected` 连同诊断标签一起回传，提示词要求模型"多做 kept 那类，避开 rejected 那类"。

### 3.7 搜索、链接与图片的三种呈现

模型自己判断该案例用哪种"配准（register）"呈现，服务端据此渲染：

- **WORDS**（纯文字）——当一句话就能承载洞见时，只命名案例 + 说清它怎么工作，不配链接。
- **LINK**（链接卡片）——当那个页面本身值得访问（一个可试用的产品、一篇该读全文的论文）时，模型把案例名写成 markdown 链接；服务端 `makeLinkStripper()` 把链接从文本里剥出来，做成 URL 卡片，缩略图取该页自己的 `og:image`（可证匹配）。
- **IMAGE**（内联图）——当案例天然是视觉的（一个 UI、一张图、一个实物）时，模型写 markdown 图片语法（用**页面 URL**，不是猜直链），服务端抓该页 og:image 内联渲染进那条 bullet。

搜索路径的差异：

- **CLI 后端**（Claude / Codex）**原生联网搜索**，服务端从其结构化输出里 harvest 出 URL。提示词强制它"先真的搜，再写"。
- **open 后端**不能自己搜，于是让模型输出一行 `SEARCH: <query>` / `SEARCH IMAGE: <query>`（推理出的查询），服务端用**那个 query** 去调 Tavily。这一行同样被拦截、不展示。

### 3.8 流式传输

延迟是"被感知"的，所以共创**从不等整段响应**。`/api/cocreate` 用 **NDJSON**（一行一个 JSON 对象）把内容边生成边推回画布：

```
{ "type": "diagnosis", "text": "..." }   ← 先于所有文本
{ "type": "anchor", "line": 2 }          ← 先于所有文本
{ "type": "text", "text": "- ..." }      ← 逐行的 bullet
{ "type": "image", "src": "...", "line": 1 }
{ "type": "urls", "urls": [ ... ] }
{ "type": "done", "model": "...", "provider": "..." }
```

前端 `requestCocreate()`（`services/llm/cocreate.ts`）逐行解析这些事件，实时画到画布上。AI 开关中途关闭 = `AbortController` 取消流，被当作"取消"而非"失败"。

---

## 四、Tier-3 显式命令

除了环境 fire，底部命令栏支持**显式命令**（`command` 字段，如"去搜几个语音转文字产品"）。走同一个 `/api/cocreate`，但用 `COMMAND_SYSTEM` 提示词：更简短，一条 bullet，web 搜索供灵感 URL。

---

## 五、两个机制的共同原则（可作为讨论锚点）

1. **原始信号隐藏、清洗后才展示**：STT interim 不展示；模型 reasoning 被解析/剥离而非打印。
2. **解耦节奏**：快而频繁的清洗 vs 慢而背景的结构化 / 环境共创；各自的延迟预算不同。
3. **绝不丢失用户内容**：转写出错把 raw 放回重试；共创 append-only，永不覆盖人类文字。
4. **用模型判断替代人手规则**：段落边界、共创的"做什么/做多少"，都交给模型判断并强制其说出理由，用户反应再回灌成学习信号。
5. **供应商可插拔**：STT 和 LLM 后端都在统一契约后面，换供应商不动 UI。
