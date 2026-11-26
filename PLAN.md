# LLM API 组件 — 设计计划

> 状态：核心计划完成（价格统计、WebSocket mid-turn steering 等会话控制面除外），75 个契约测试通过
> 参考：`snnh/openwebcode`（服务商档案模型）、`snnh/dsh-llm-service-lite`（适配器信条与失败语义）

## 1. 目标与非目标

**目标**

- 一个可嵌入的 TypeScript 库，承担 LiteLLM / pi-ai 的角色：统一 `chat` / `chatStream`（后续 `embed` / `rerank` / `image`）。
- 厂商与模型全部由配置定义：加一个模型 = 改配置，不改库代码、不发版。
- 配置分三层（协议档案 → 模型家族 → 单模型），未声明的模型自动落到家族回退。
- 对外提供配置接口（schema / describe / validate / apply / save / 事件），调用方据此自行开发网页改配置。
- 公开词汇与 `openwebcode` / DSH 对齐，配置可双向迁移。
- 作为 LiteLLM 的替代：同一份调用代码换厂商/换协议不改，模型寻址支持 `provider/model` 与别名。
- 参数发送遵循"不瞎传"：未提供的、未声明的、接口非必需的字段一律不出现。
- 配置文件**不追求与 LiteLLM 格式兼容**（两者形状不同，兼容会把"可配"压回 LiteLLM 的字段集）；"用户方便"指的是**绝大多数能力都能在配置里表达**，而不是迁移一份旧 YAML。

**非目标**

- 不做 HTTP 服务、不做内置 UI。
- 不做多端点故障转移、负载均衡、计费与配额。
- 不内置任何厂商 SDK，请求路径只有 `fetch`。
- 不在 M1 覆盖 `openai-responses`、多模态与 embeddings。

## 2. 决策记录

| # | 决策 | 结论 | 被否掉的方案与原因 |
|---|---|---|---|
| 1 | 交付形态 | 可嵌入库，无 HTTP | 独立网关（多一层部署与鉴权问题） |
| 2 | 对标 | LiteLLM / pi-ai：统一接口 + 多厂商 | 纯 HTTP 转发层（放弃统一语义） |
| 3 | 结构差异表达 | 少量接口枚举 + 其余全配置 | 自造模板 DSL / JSONata（等于发明小语言，配置冗长） |
| 4 | 配置粒度 | provider 默认 + family 回退 + model 覆盖 | 每条模型自包含（重复不可维护） |
| 5 | 配置格式 | 核心吃对象；`loadConfig` 支持 JSON + 可选 YAML | 只 JSON（不能写注释）/ 只 YAML（强制依赖） |
| 6 | 流式契约 | 统一事件流，另给调试钩子 | 透传原始帧（等于把问题交回调用方） |
| 7 | 运行时 | Node 24 + 少量依赖（zod、eventsource-parser、yaml 可选） | 零依赖（自写校验与分帧，出错面更大） |
| 8 | 调用方法 | `chat()` 与 `chatStream()` 两个方法 | 单方法 + 联合返回（调用方每次窄化） |
| 9 | 三层框架 | protocol/provider → family → model，model 可选 | 全局 default family（几乎必然猜错） |
| 10 | 家族归属 | `family.match` + provider 兜底，歧义报错 | 限定名前缀（调用方必须带前缀） |
| 11 | 参数策略 | 任意键透传 + 少量归一 | 严格白名单（挡住 top_k/thinking 等常见需求） |
| 12 | 韧性 | 超时 + 取消 + 有限重试（429/5xx，≤3） | 全量（并发限制/多 key 轮换，库变重） |
| 13 | 配置接口 | schema + describe + validate + apply + save + 事件 | 细粒度 CRUD/草稿/版本回滚（面太大） |
| 14 | 失败语义 | 容忍 + 诊断，写入处拒绝 | 全或无（一处错字回滚整份草稿） |
| 15 | 模型发现 | 规则内置 + 可覆盖，候选不落盘 | 只支持 OpenAI 兼容（其他端点用不了） |
| 16 | M1 交付物 | 库 + 契约测试 + example | CLI（不在本轮范围）/ 网页示例（拉长 M1） |
| 17 | 词汇 | 完全对齐 openwebcode/DSH | 自造事件名（迁移成本长期存在） |
| 18 | 字段支持 | 语义开关 + 三个静态注入点 | 只做静态注入（换厂商要改配置） |
| 19 | 缓存 | 三态 `caching: explicit / auto / none` | 布尔 `promptCaching`（读不出 auto） |
| 20 | 容器 | 带 `id` 的数组 | 键值映射（与 OWC 文档形状不一致） |
| 21 | 替代 LiteLLM 的边界 | 替代其客户端/统一调用层；不替代代理网关（虚拟密钥、预算、限流） | 全量对齐（会把库做成网关） |
| 22 | 参数发送 | 不瞎传：`undefined`/`null` 不发、未声明不发、非必需不发；必需字段缺失报错 | 回填默认值（改变上游行为，且与"声明即承诺"冲突） |
| 23 | 模型寻址 | 平铺 id + `provider/model` + `aliases` | 仅平铺（LiteLLM 用户迁移要改代码） |
| 24 | 故障转移 | 不做 fallback / 多模型切换（LiteLLM 的 Router 层能力） | 纳入范围（会增加隐藏路由与切换语义，与"透明"冲突） |
| 25 | 思考档位 | 不做档位映射：`effort` 原样下发，思考长度由调用方给（`thinkingBudgetTokens`）；配置里的 `effort` 只作 UI 提示 | 内置档位表（等于替用户猜厂商词汇，且必然过时） |
| 26 | 多协议端点 | `interfaceType` 可按家族/模型覆盖，`baseUrl` 亦可 | 一个端点拆成两个 provider 条目（模型重复） |
| 27 | `models` 语义 | 按 id 打补丁：标量替换、映射按 key 合并、`null` 删除；未命中家族且无 `family` → 报错 | 整段替换（改一处清空别处） |
| 28 | `compat` 范围 | 只做结构与字段差异（system 位置、上限字段名、省略）；思考沿用 `thinkingStyle` | 再加一套 `thinkingFormat`（与既有适配打架） |
| 29 | 价格统计 | 不做：不建 pricing 字段、不提供成本估算 | 内置价格表/成本 API（价格易变，且与"配置即全部事实"边界不清） |
| 30 | 未履行的开关 | 不保留：移除 `imageOutput` / `strictTools`（没有行为就不放进能力表） | 留着当占位（违背"声明即承诺"） |
| 31 | 家族匹配 | **最长匹配优先**；只有同等具体度才算歧义 | 一有多个匹配就报错（`glm-5.3` 会被 `glm-5` 拖成歧义） |
| 32 | deferLoading | chat-completions 与 anthropic-messages 都支持（DeepSeek 也认 `defer_loading`）；responses 拒绝 | 只限 Anthropic（会漏掉 DeepSeek/Kimi） |
| 33 | 内置主流配置 | 提供 `presets/mainstream-2026-11.config.yaml`（19 端点 / 35 家族 / 26 模型），上下文按官方值、不确定的取保守值 | 不做价格表（决策 29） |
| 34 | 模型拒绝的参数 | 新增 `capabilities.unsupportedParams`：仅作建议元数据，列出模型可能拒绝的字段，供 UI/调用方参考；库不据此拦截请求 | 每家电硬编码参数黑名单（必然过时） |
| 35 | GPT-6.2 | 新增 `gpt-6.2-astra` / `gpt-6.2-sol` 家族：1.05M / 128K、`thinking` 恒开、`effort` 只列 `low`–`max`、工具只走 Responses | 挂到 `gpt-6` 家族（会继承旧的宽松声明） |
| 36 | 异步工具 | Responses 函数工具支持 `async: true`，输出 `tool_call.async` 可回放；其他 wire 声明即报错。WebSocket mid-turn steering 不做（属于流式控制面） | 全做（库变成 agent runtime） |
| 37 | 不支持参数（`unsupportedParams`） | 只给建议、不强制拦截：用户坚持传不支持的参数时原样下发，上游错误原样返回（回退决策 34 的硬拦）；图片/思考/工具/deferLoading 的既有声明校验不变 | 本地 `UNSUPPORTED_FEATURE` 硬拦（用户无法试新参数） |
| 38 | 强制模式 | 配置加 `force`（root/provider/family/model，最具体优先）；`true` 时跳过运行时能力声明校验（图片、thinking、tools、deferLoading），用户设置原样下发；schema、wire 结构与配置期诊断仍保留 | 默认全部放开（失去"声明即承诺"的默认安全） |
| 39 | 会话中改思考 | Responses 加 `configurationUpdates`，按顺序插在最新 user 消息前；非 Responses 结构性拒绝（force 不绕过） | 只能重写请求级 `reasoning.effort`，可能触发前缀失效 |
| 40 | DeepSeek 双协议 | chat 线回放 `reasoning_content`（工具调用必需）；新增 `deepseek-flash` / `deepseek-v4-pro-responses` 走 Responses，解析并回放 plain-text reasoning；`configuration_update` 在 DeepSeek 上会被忽略，文档明确用请求级 effort | 强行给 DeepSeek 伪造 `configuration_update`（无服务端语义） |
| 41 | 末尾更新工具/思考 | Anthropic Messages 支持 `role:'system'` 消息：`toolChanges` 生成 `tool_addition`/`tool_removal`，`outputConfig.effort` 生成逐消息 `output_config`；自动带两个 beta 头；其他 wire 结构性拒绝 | 改顶层 `tools`/`system`（会破坏前缀缓存） |
| 42 | Responses prompt cache | 新增 `promptCacheOptions`（`mode`/`ttl`/`prewarm`）、`promptCacheKey` 与文本块 `promptCacheBreakpoint`；`ttl` 只接受 `30m`/`12h`；其他 wire 结构性拒绝 | 让调用方自己拼 `extra`（类型不可见，容易把 camelCase 字段发到线上） |
| 43 | Anthropic redacted thinking | 解析并回放 `redacted_thinking.data`；空 `thinking` + `signature` 也回放 | 过滤非 `thinking` 块（会静默破坏多轮工具协议） |
| 44 | 多 reasoning 块 | `Thinking.blocks` 按顺序保留全部 thinking / redacted_thinking 块并原样回放 | 只保留最后一块（会破坏多轮工具协议） |
| 45 | Gemini 原生协议 | 新增 `gemini-generate-content`：`contents/parts`、`systemInstruction`、`functionDeclarations`、`generationConfig`；`thinkingStyle` 决定 `thinkingConfig`；保留 `thoughtSignature`（text / tool call）供多轮回放；延迟工具、显式缓存、会话中 system 更新结构性拒绝。preset 保留 Google OpenAI 兼容端点，新增 `google-native` 与 `*-native` 模型 | 只走 Gemini 的 OpenAI 兼容端点（拿不到原生 thinking/签名语义） |

## 3. 概念模型

```
providers[]  ── 一条路由 = 一个端点 + 一个接口类型 + 凭据
families[]   ── 按模型名前缀匹配的回退参数（上下文、能力、默认采样）
models[]     ── 单个模型的差异（可选）
```

解析顺序：`model > family > provider`，同名段**整段替换**，不做深合并（避免"半个 wire"的歧义）。

请求落到哪个条目：

1. `model` 是 `models[]` 里的 `id` → 用它，家族取 `model.family` 或按 `match` 命中；
2. 否则按 `families[].match` 命中 → 该家族的 provider（家族可指定 `provider`，否则用命中 provider 的 `family`）；
3. 否则用请求目标 provider 的 `family`；
4. 都没有 → `INVALID_CONFIG`，错误里列出候选家族与 provider。

模型寻址（三种写法，优先级从高到低）：

1. `provider/model`：`deepseek/deepseek-chat` → 端点 `deepseek` + 线上模型名 `deepseek-chat`（LiteLLM 习惯，迁移最省事）；
2. `models[].id` 或 `models[].aliases`：配置里起的名字，可指向任意 `upstream`；
3. 裸模型名：先查 `models[]`，未命中则按 `families[].match` 命中，再按 provider 的 `family` 兜底。

同名冲突（多个 provider 下都有 `deepseek-chat`）时：请求可带 `provider:` 消歧，否则报 `AMBIGUOUS_MATCH` 并列出候选。

## 4. 配置规范

### 4.1 文件与加载

```ts
createLLM(config: LLMConfig, opts?: {
  env?: Record<string, string>;   // 覆盖 process.env 的解析源
  strict?: boolean;               // true: 未知字段为 error；默认 warning
  source?: string;                // 记录来源，供 save() 写回
}): LLM

loadConfig(path: string, opts?): LLMConfig    // .json / .yaml / .yml
```

- 核心 API 接受普通对象，文件只是便利层。
- YAML 通过可选 peer 依赖 `yaml` 动态 import；未安装时报 `INVALID_CONFIG` 并说明安装方式。
- 顶层字段：`version`、`force`、`defaults`、`providers`、`families`、`models`。
- 环境引用写法：`apiKeyEnv: DEEPSEEK_API_KEY`，或 `auth.env`。内联 `apiKey` 允许（导入场景），`describe()` 永远脱敏。
- 未知字段：默认保留并给 `UNKNOWN_FIELD` warning；`strict: true` 时升级为 error。保留是为了网页保存时不丢新版本字段。

### 4.2 `providers[]`

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 必填 | 路由名，`[A-Za-z0-9._-]{1,64}`，全局唯一 |
| `enabled` | `true` | 停用后不注册，但仍可被列出与修复 |
| `force` | `false` | 跳过该端点的运行时能力校验，见 4.5 |
| `interfaceType` | 必填 | `openai-chat-completions` / `anthropic-messages` / `openai-responses` / `gemini-generate-content` |
| `baseUrl` | 接口默认 | 如 `https://api.deepseek.com/v1`；也承载网关前缀 |
| `path` | 接口默认 | 覆盖默认路径（`/chat/completions`、`/messages`）；Gemini 支持 `{model}` / `{method}` 占位 |
| `query` | 无 | 静态查询参数 |
| `headers` | 无 | 静态请求头 |
| `auth` | 按接口推断 | `{ header, scheme, env }`，如 `{ header: x-api-key, scheme: '', env: ANTHROPIC_API_KEY }` |
| `apiKey` / `apiKeyEnv` | 无 | `auth` 的简写；两者同时存在时 `auth` 优先 |
| `caching` | `auto` | `explicit` / `auto` / `none`，见 4.6 |
| `includeUsage` | `false` | 仅 chat-completions：请求 `stream_options.include_usage` |
| `extraBody` | 无 | 浅合并进 body 根；核心键不可覆盖 |
| `toolFields` | 无 | 浅合并进每个工具声明 |
| `messageFields` | 无 | 浅合并进每条消息对象 |
| `fieldMap` | 无 | 归一字段落名覆盖，见 4.7 |
| `family` | 无 | 端点默认家族 |
| `maxConcurrent` | 不限制 | 超过后排队（M2 实现，M1 只校验） |
| `streamIdleTimeoutMs` | `300000` | 两个流事件之间的最大间隔 |
| `connectTimeoutMs` | `30000` | 建立连接超时 |
| `retry` | `{ maxAttempts: 3, statuses: [429,500,502,503,504] }` | 只对这些状态与 `Retry-After` 生效 |
| `discover` | 按接口内置 | `{ path, readPath }`，见 5.4 |
| `errors` | 按接口内置 | `{ "429": "QUOTA" }` 这类状态到错误码覆盖 |

认证默认：`openai-chat-completions` → `authorization: Bearer <key>`；`anthropic-messages` → `x-api-key: <key>` + `anthropic-version`；`gemini-generate-content` → `x-goog-api-key: <key>`。

### 4.3 `families[]`

| 字段 | 说明 |
|---|---|
| `id` | 家族名 |
| `force` | 跳过该家族的运行时能力校验，最具体层优先 |
| `match` | 字符串前缀或正则数组，如 `["deepseek-", "^glm-"]` |
| `provider` | 该家族默认端点（可选） |
| `interfaceType` | 可选：该家族默认协议（多协议端点时用） |
| `baseUrl` | 可选：该家族默认端点（少见） |
| `contextWindow` | 上下文窗口，未声明时回落 `256000` |
| `maxOutput` | 输出上限，未声明时回落 `65536` |
| `defaults` | `{ temperature, topP, topK, maxTokens }`，只补调用方未给的字段 |
| `capabilities` | 见 4.5 |
| `extraBody` / `toolFields` / `messageFields` / `fieldMap` | 与 provider 同义，**按 key 合并** |

### 4.4 `models[]`

`id`（对外名字）、`force`（跳过该模型的运行时能力校验）、`aliases`（可选别名数组，便于迁移 LiteLLM 的 `model_name`）、`provider`、`family`、`upstream`（线上真实模型名，默认同 `id`）、`interfaceType`（可选，覆盖协议）、`baseUrl`（可选，覆盖端点），以及 `contextWindow` / `maxOutput` / `defaults` / `capabilities` / `extraBody` / `toolFields` / `messageFields` / `fieldMap` 的覆盖。

**补丁语义（按 id 合并，不是整段替换）**

- 每条 model 是"家族有效配置"上的补丁；没写的字段继续继承；
- 标量字段（`contextWindow`、`maxOutput`、`interfaceType`、`baseUrl`、`upstream`）直接替换；
- 映射字段（`capabilities`、`defaults`、`extraBody`、`toolFields`、`messageFields`、`fieldMap`）**按 key 合并**，写 `null` 表示显式删除该 key；
- `models[]` 的 id 未命中任何家族、又没写 `family` → `NO_MATCH` 报错（防止拼错 id 后静默长出一个空模型）；要声明全新模型请显式写 `family: default`（随包提供的保守家族）。

`models[]` 完全可选。不写时：任意模型名只要命中家族 `match` 就能调用——这是"日常新增模型不改配置文件"的关键。

### 4.5 `capabilities`

| 能力 | 取值 | 落地 |
|---|---|---|
| `modalities` | `text` / `image` / `video` | 允许的输入内容块；超出即 `UNSUPPORTED_FEATURE`（`force` 时跳过） |
| `tools` | `boolean` | 允许发送工具声明；false 时请求里的 tools 被拒绝而不是静默丢弃（`force` 时跳过） |
| `thinking` | `enabled` / `disabled` / `adaptive` | 接受的思考模式；值原样下发，库不翻译（`force` 时跳过列表校验） |
| `effort` | 任意字符串（可选） | **仅作 UI 提示**：库不建档位表、不映射、不校验，调用方给什么就发什么 |
| `unsupportedParams` | 字符串数组 | **仅建议**：模型可能拒绝的请求字段；库不拦截，参数原样下发 |
| `thinkingStyle` | `thinking` / `enable_thinking` / `effort_only` / `fixed` / `extended` / `adaptive` | 思考开关的**落字段形式**（不是档位映射） |
| `reasoningContent` | `boolean` | chat 线回带 `reasoning_content`；Responses 线回放 plain-text reasoning item |
| `outputConfigEffort` | `boolean` | Anthropic：`thinkingStyle: thinking` 时也给 `output_config.effort`；其他 wire 声明即报错 |
| `responsesEncryptedReplay` | `boolean` | Responses 加密推理回放（M2） |
| `deferLoading` | `boolean` | 工具声明可带 `defer_loading`，见 4.8；未声明时拒绝（`force` 时跳过） |
| `parallelToolCalls` | `boolean` | 仅 chat-completions 可关闭并行工具；其他接口声明即报错 |

"声明即承诺"：没声明的不发送；声明了却无法履行（例如在 responses 上传 `deferLoading`）→ 挂载/写入时报错，而不是接受后无人在用。需要覆盖声明时，显式写 `force: true`（决策 38）。

`force` 可按 `model > family > provider > root` 取最具体值；为 `true` 时运行时跳过图片/thinking/tools/deferLoading 的能力声明拒绝，但配置 schema、wire 结构与配置期诊断照常。

请求级校验同样按声明执行：内容里带图片但 `modalities` 未声明 `image` → `UNSUPPORTED_FEATURE`；`thinking` 不在声明列表 → `INVALID_REQUEST`；`cacheBreakpoints` 只允许 anthropic + `caching: explicit`；`ToolDef.async` 只允许 Responses；Gemini 不支持 `deferredTools` / 异步工具 / `caching: explicit`；`role:'system'` 的 `toolChanges`/`outputConfig` 只允许 anthropic-messages；`promptCacheOptions` / `promptCacheBreakpoint` 只允许 Responses。`force: true` 时跳过能力声明校验（图片/thinking/tools/deferLoading），wire 结构校验保留。`unsupportedParams` 是例外：始终只给建议，不拦截，参数与上游错误都原样透传。

### 4.6 缓存

- `explicit`：库在 system、工具声明、末条消息打 `cache_control` 断点；Anthropic 上限 4 个，超出截断并 warning。
- `auto`（默认）：不打任何断点，端点自己缓存（国内 Anthropic 兼容端点常见）。
- `none`：不打断点，也不期待命中。
- 请求可带 `cacheBreakpoints: [消息 id]` 指定断点位置；与 `caching` 不符时报 `UNSUPPORTED_FEATURE`（`auto`/`none`）或按上限截断（`explicit`）。
- **usage 永远上报** `cacheRead` / `cacheWrite`，不因 `caching` 被吞。

### 4.7 参数与字段

请求参数处理顺序：

1. 归一字段（`model`、`messages`/`system`、`stream`、`tools`、`maxTokens`、`temperature`、`topP`、`topK`、`stop`、`seed`、`thinking`、`effort`、`jsonMode`）由接口实现按协议落字段；
2. `extraBody` 浅合并进 body 根；
3. 请求里的 `extra` 对象原样浅合并进 body 根，覆盖 `extraBody`；
4. 调用方直接在请求上传的非归一键，原样并入 body 根（任意键透传）；
5. 核心键（`model` / `messages` / `stream` / `tools` / `system`）只能由库写，`extraBody` 与 `extra` 中出现即报错。

`fieldMap` 只改归一字段的落名，例如 `{ maxTokens: max_completion_tokens }`；不影响 `extraBody` / `extra`。

### 4.8 `deferLoading`

1. 家族或模型声明 `capabilities.deferLoading: true`；
2. 请求可带 `deferredTools: ["read_media"]`，或工具项上写 `deferLoading: true`；
3. 接口实现把被推迟工具的声明加 `defer_loading: true`（Anthropic Messages 形态；chat-completions 不支持则该能力声明直接报错）；
4. 模型未声明该能力却传了 `deferredTools` → `INVALID_REQUEST`，不静默降级；
5. 语义开关优先于 `toolFields.defer_loading`，冲突时 `validate` 给 warning。

### 4.9 校验与诊断

```ts
interface Diagnostic {
  path: string;                          // providers[0].baseUrl
  code: 'INVALID_TYPE' | 'INVALID_URL' | 'UNKNOWN_FIELD' | 'UNRESOLVED_REF'
      | 'DUPLICATE_ID' | 'NO_MATCH' | 'AMBIGUOUS_MATCH' | 'UNSUPPORTED_FEATURE' | 'INVALID_VALUE';
  severity: 'error' | 'warning';
  message: string;
}
```

- `createLLM` / `apply`：结构错误整份拒绝；语义错误按条目容忍（`state: 'error'` + diagnostics），其余条目照常工作。
- **写入处拒绝**：新增或修改的条目若语义不合法，`apply` 返回失败且旧配置不变。
- 已经存下来的坏条目仍可被 `models()` 列出、被 `model(id)` 取到，方便网页按名修复。

### 4.10 参数发送规则（不瞎传）

**三条硬规则**

1. **未提供不发**：`undefined` 与 `null` 一律不写进请求；空数组/空对象不写（`tools: []`、`stop: []`、`extra: {}`）。
2. **未声明不发**：家族/模型没声明的东西不发——`thinking`/`effort` 未声明 → 不发思考参数；`caching: auto | none` → 不发 `cache_control`；`deferLoading` 未声明 → 不发 `defer_loading`；`includeUsage: false` → 不发 `stream_options`；`promptCaching` 未声明 → 一个断点都不打。
3. **非必需不发**：接口不要求的字段不出现——chat-completions 的 `max_tokens` 只在请求或 `defaults.maxTokens` 给出时发；`temperature` / `top_p` / `stop` / `seed` / `response_format` / `tool_choice` 未给就不发；`system` 为空串不发；`n` / `logprobs` 不在归一集合内，只能经 `extra` 显式传。

**必需字段**：Anthropic Messages 的 `max_tokens` 是协议必需。取值顺序：请求 `maxTokens` → 模型/家族 `defaults.maxTokens` → `maxOutput`；三者都没有 → `INVALID_REQUEST`，**不臆造默认值**。

**默认值**：只有配置 `defaults` 里写的值才会补，且只补调用方未给的字段；库不内置任何采样默认（temperature=1、top_p=1 这类一律不写）。

**透传**：调用方显式给的非归一键（非 `undefined`）原样并入 body 根，这是"开发者自由"；库不替你补键、不补空值、不补默认。

**不翻译档位**：`effort` / `thinking` / `thinkingBudgetTokens` 一律原样落到 `thinkingStyle` 指定的字段，库不建"low→high"这类档位表，也不把 `max` 改写成 `ultra`。厂商词汇不同就由调用方自己传该厂商的写法，或给该模型单独配一份配置。

**自检**：契约测试对每个接口断言"最小请求"的字段集合——例如只给 `model + messages` 时，chat 端点收到的 body 恰好是 `{model, messages}`，Anthropic 端点恰好是 `{model, messages, max_tokens}`。

### 4.11 协议覆盖与 `compat`

`interfaceType` 可在家族与模型上覆盖，优先级：`models[] > families[] > providers[] > 接口默认`；端点同理：`models[].baseUrl > providers[].baseUrl > 接口默认`。用于一个端点同时提供两种协议（如 `/v1/chat/completions` 与 `/v1/messages` 挂在同一域名）。

`compat` 只处理**结构差异**，不处理思考形态（思考沿用 4.5 的 `thinkingStyle`，避免两套适配打架）：

| 开关 | 取值 | 作用 |
|---|---|---|
| `systemPrompt` | `field` / `message` | system 是独立字段，还是首条 message |
| `maxTokensField` | `max_tokens` / `max_completion_tokens` / `max_output_tokens` | 输出上限的字段名 |
| `omitMaxTokens` | `boolean` | 显式不发送输出上限（网关不认该字段时） |

`omitMaxTokens: true` 与"协议必需"冲突时（Anthropic Messages 必须有 `max_tokens`）在写入处拒绝，而不是发出一个注定被拒的请求。

## 5. 公共 API

### 5.1 `createLLM`

```ts
function createLLM(config: LLMConfig, opts?: CreateOptions): LLM;
```

### 5.2 调用

```ts
interface ChatRequest {
  model: string;
  provider?: string;                 // 同名模型消歧
  system?: string;
  messages: Message[];               // 可含 role:'system'（Anthropic 末尾更新）
  tools?: ToolDef[];
  deferredTools?: string[];
  thinking?: 'adaptive' | 'enabled' | 'disabled';
  effort?: string;                   // 原样下发；库不做档位映射
  thinkingBudgetTokens?: number;     // 思考长度由调用方给（Anthropic extended 形态）
  configurationUpdates?: ConfigurationUpdate[]; // Responses：插在最新 user 前，改 effort/format
  promptCacheOptions?: PromptCacheOptions;      // Responses：prompt_cache_options
  promptCacheKey?: string;                       // Responses：prompt_cache_key
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stop?: string[];
  seed?: number;
  jsonMode?: boolean;
  cacheBreakpoints?: string[];
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface PromptCacheOptions {
  mode?: 'implicit' | 'explicit';
  ttl?: '30m' | '12h';
  prewarm?: boolean;
}

interface PromptCacheBreakpoint {
  mode: 'explicit';
  ttl?: '30m' | '12h';
}

type ContentPart =
  | { type: 'text'; text: string; promptCacheBreakpoint?: PromptCacheBreakpoint } // Responses
  | { type: 'image'; data: string; mediaType: string };

type ThinkingBlock =
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

interface Thinking {
  text: string;
  signature?: string;                // Anthropic
  redacted?: string;                 // Anthropic last/only redacted block
  blocks?: ThinkingBlock[];          // Anthropic ordered blocks
  encrypted?: string;                // Responses encrypted_content
}

chat(req: ChatRequest): Promise<ChatResult>;
chatStream(req: ChatRequest, opts?: {
  signal?: AbortSignal;
  onRawEvent?: (raw: string) => void;   // 调试：原始 SSE 帧，密钥不经过这里
}): AsyncIterable<LLMEvent>;
```

`chat()` 内部由 `chatStream()` 归并，保证两条路径语义永不分叉。

### 5.3 配置接口

```ts
models(): ModelView[];                 // 家族补齐后的有效视图（含坏条目）
model(id: string, provider?: string): ModelView | undefined;
providers(): ProviderView[];

describe(): RedactedConfig;            // 密钥只显示掩码或 env 引用名
validate(next?: unknown): Diagnostic[];
apply(next: unknown): ApplyResult;     // 事务：失败时旧配置不变
save(): Promise<void>;                 // 原子写回 source；保留不认识的字段
onConfigChange(fn: (change: ChangeEvent) => void): () => void;
readonly schema: JSONSchema;           // 供网页生成表单
```

`ApplyResult = { ok: true; changed: string[] } | { ok: false; diagnostics: Diagnostic[] }`

运行时语义：

- `apply` 成功后，**下一次请求**看到新配置；进行中的请求保持启动时的快照。
- `save` 先写临时文件再 rename；`describe` 脱敏但 `save` 使用原始值，密钥不会因编辑而被覆盖。
- 变更事件给出去重后的条目 id 列表（`providers` / `families` / `models` 各自）。

### 5.4 模型发现

```ts
discover(providerId: string): Promise<ModelCandidate[]>;
// ModelCandidate = { id: string; contextWindow?: number; capabilities?: Partial<Capabilities> }
```

- 内置规则：chat-completions → `GET {baseUrl}{discover.path ?? '/models'}` 读 `data[*].id`；anthropic-messages → `GET {baseUrl}/models` 读 `data[*].id`（带 `x-api-key` 与 `anthropic-version`）；gemini-generate-content → `GET {baseUrl}/models` 读 `models[*]`，兼容 `name` / `inputTokenLimit` / `outputTokenLimit`。
- `discover` 只读、不落盘，候选由网页决定是否写入配置。
- 端点不可达 / 非 JSON / 超过 4 MiB → `TRANSPORT` / `INVALID_REQUEST`。

## 6. 事件契约

```ts
type LLMEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_end'; text: string; signature?: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_end'; text: string; signature?: string; redacted?: string; encrypted?: string; block?: ThinkingBlock }
  | { type: 'tool_call_delta'; id: string; name?: string; argumentsDelta: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; itemId?: string; async?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error' }
  | { type: 'error'; error: LLMError };
```

- 工具参数跨帧拼装由库完成：`tool_call_delta` 给出增量，`tool_call` 给出完整 `input`。
- `done` 一定出现（成功或被截断都出现）；流在没有任何内容时结束 → `EMPTY_RESPONSE`。
- `thinking_end.signature` 与 `redacted` 原样保留，供下一轮 Anthropic 回放；`display: "omitted"` 的空 thinking + signature 也按原样回传。
- 取消（`AbortSignal`）→ 抛 `ABORTED`，不产生 `done`。

`ChatResult` 是事件流的归并：`{ text, thinking?, toolCalls[], usage, stopReason }`。

## 7. 错误模型

```ts
class LLMError extends Error {
  code: ErrorCode; provider?: string; model?: string;
  status?: number; retryAfterMs?: number; diagnostics?: Diagnostic[];
}

type ErrorCode =
  | 'MISSING_CREDENTIAL' | 'INVALID_REQUEST' | 'QUOTA' | 'CONTEXT_WINDOW_EXCEEDED'
  | 'TRANSPORT' | 'EMPTY_RESPONSE' | 'INVALID_CONFIG' | 'UNSUPPORTED_FEATURE' | 'ABORTED';
```

- 分类在传输层完成（只有它看到了完整响应）：HTTP 状态 + 错误体路径 → 稳定错误码。
- `429` 默认 `QUOTA`（配额耗尽与限流细分由 `provider.errors` 覆盖）；`401/403` → `MISSING_CREDENTIAL`（凭据被拒与缺失分开诊断）；`4xx` → `INVALID_REQUEST`；`5xx`/网络 → `TRANSPORT`。
- `Retry-After` 解析后交给重试层，不吞进错误里。

## 8. 传输与运行时语义

- 只用 `fetch` + `AbortSignal`；SSE 用 `eventsource-parser` 分帧，只在数据帧上打点。
- 超时：连接 `connectTimeoutMs`；流空闲 `streamIdleTimeoutMs`（两次事件之间）。
- 重试：仅对配置的状态码，`maxAttempts` 次，指数退避并尊重 `Retry-After`；`400/401/403/404` 不重试。
- 快照：每次请求解析并冻结一次有效配置（端口、凭据引用、能力），中途 `apply` 不影响在途请求。
- 凭据：每个请求解析一次 `env`（`opts.env` 优先于 `process.env`），解析不到 → `MISSING_CREDENTIAL`，绝不未认证发请求。
- 日志：不打印密钥；`onRawEvent` 只给帧，不给请求头。

## 9. 接口实现

### 9.1 `openai-chat-completions`（M1）

- `POST {baseUrl}{path|/chat/completions}`，`authorization: Bearer`。
- body：`model`、`messages`（system 作为首条 message）、`stream`、`tools`（`{type:'function',function:{name,description,parameters}}`）、`tool_choice`、`max_tokens`（可被 `fieldMap` 改成 `max_completion_tokens`）、`temperature`、`top_p`、`stop`、`seed`、`response_format`。
- 流：`data: {...}` + `data: [DONE]`；读 `choices[0].delta.content`、`reasoning_content`、`tool_calls[].function.arguments`；`finish_reason` → `stopReason`。
- `includeUsage: true` 时加 `stream_options: { include_usage: true }`。
- 缓存：`auto`/`none` 都不发断点；OpenAI 是自动缓存，`explicit` 在写入处报 `UNSUPPORTED_FEATURE`。

### 9.2 `anthropic-messages`（M1）

- `POST {baseUrl}{path|/messages}`，`x-api-key` + `anthropic-version`。
- body：`system` 独立、`messages`（user/assistant content blocks、`tool_result`）、`max_tokens` 必发、`tools`（`input_schema`）、`thinking`。
- `thinkingStyle: extended` 时发 `thinking: { type: 'enabled', budget_tokens: <请求给的 thinkingBudgetTokens> }`；未给长度则只发 `{type:'enabled'}` 或按 `adaptive` 形态，不替调用方编一个预算值。
- 流：`message_start` / `content_block_start` / `content_block_delta`（`text_delta`、`input_json_delta`、`thinking_delta`、`signature_delta`）/ `message_delta`（`stop_reason`、`usage`）/ `message_stop` / `ping`；`redacted_thinking` 在 `content_block_start.data` 中整体返回，`content_block_stop` 归并为 `thinking_end` 并带 `block`。
- 末尾 `toolChanges` 在请求校验阶段检查工具名必须出现在 `tools` 中。
- 缓存：`caching: explicit` 时在 system、工具声明（最后一个）、末条消息打 `cache_control: {type:'ephemeral'}`，最多 4 个；`auto` 不发。
- 工具配对修复：丢弃已无结果的调用、重复 id 折叠、无人回答的调用补占位结果、并行结果合并为一个 user 回合。

### 9.3 `openai-responses`（M2）

`input` 扁平 item 列表、`function_call`/`function_call_output`、`reasoning` item 回放、`max_output_tokens` 必发。`promptCacheOptions` 映射为 `prompt_cache_options`，`promptCacheKey` 映射为 `prompt_cache_key`，文本块的 `promptCacheBreakpoint` 映射为 `prompt_cache_breakpoint`；`prewarm` 的空输出不判 `EMPTY_RESPONSE`。

### 9.4 `gemini-generate-content`（M4）

- `POST {baseUrl}{path|/models/{model}:{method}}`，`x-goog-api-key`；非流式 `:generateContent`，流式 `:streamGenerateContent?alt=sse`。
- body：`contents`（`user`/`model` parts、`inlineData`、`functionCall`、`functionResponse`）、`systemInstruction`、`tools[0].functionDeclarations`、`generationConfig`（`maxOutputTokens`、采样、`stopSequences`、`seed`、`responseMimeType`、`thinkingConfig`）。
- 流：SSE 每帧一个 `GenerateContentResponse`；text / `thought` part 分别映射 `text_delta` / `thinking_delta`，`functionCall` 直接映射完整 `tool_call`；`finishReason` 与 `usageMetadata` 归一。
- `thoughtSignature` 保留在 text part / function call part 上，分别对应 `ContentPart.signature` / `ToolCall.signature` 与流式 `text_end.signature` / `tool_call.signature`；provider `functionCall.id` 保留为 `ToolCall.providerId` 并回放到 `functionResponse.id`。
- `deferLoading`、异步工具、`caching: explicit`、会话中 system 工具/effort 更新、`streamFunctionCallArguments` / built-in tools 结构性拒绝；原生非文本输出 part 暂不进统一事件模型。

## 10. 目录结构

```
src/
  index.ts          # createLLM、公开 API、请求校验、事件归并
  config.ts         # zod schema、loadConfig、三层解析、ConfigState
  types.ts          # ChatRequest、Message、Capabilities、LLM、视图类型
  params.ts         # 归一/透传、extraBody/fieldMap、thinking、headers
  adapter.ts        # Adapter 契约、公共工具、空 usage、stop reason 映射
  transport.ts      # fetch、超时、取消、重试、SSE
  paths.ts          # $.a.b[0] 取值
  errors.ts         # LLMError、错误分类
  openai-chat.ts    # openai-chat-completions wire
  anthropic.ts      # anthropic-messages wire（thinking/redacted/末尾 system）
  responses.ts      # openai-responses wire（configurationUpdates/prompt cache/加密推理）
  gemini.ts         # gemini-generate-content wire（contents/parts、thinkingConfig、thought signatures）
tests/
  acceptance.test.mjs        # 别名、混协议、在途快照、abort、idle timeout
  config.test.mjs            # 三层解析、补丁、诊断、脱敏
  config-store.test.mjs      # apply/save/validate/discover
  openai.test.mjs            # chat-completions、流式工具、重试、reasoning
  anthropic.test.mjs         # messages、缓存、thinking、redacted、末尾 system
  gemini.test.mjs            # 原生 generateContent、流式、签名回放、发现
  m2.test.mjs                # responses、configurationUpdates、prompt cache、embed/rerank
  m3.test.mjs                # 加密推理回放、image、并发诊断
  dialects.test.mjs          # 国内模型方言矩阵（仅配置）
  preset-mainstream.test.mjs # 主流 preset：解析、方言、请求体断言
  finish.test.mjs            # force、advisory 参数、请求级校验、并发、messageFields
  package.test.mjs           # npm pack：dist/声明/License/示例脚本
  helpers/mock.mjs           # 本地 mock 上游
examples/
  basic.mjs                  # 读 YAML + 流式打印
  web/server.mjs             # 零构建参考网页与 API
  llm-api.config.yaml        # 示例配置
  domestic.config.yaml       # 国内方言矩阵配置
presets/
  mainstream-2026-11.config.yaml
```

> 这是落地后的实际结构；早期设计里的 `config/`、`core/`、`interfaces/` 子目录没有采用，避免为 11 个文件制造层级。

## 11. 里程碑与验收

**M1（已实现 ✅）**

- 配置：schema、`loadConfig`、三层解析、`family.match`、模型寻址（`provider/model` + `aliases`）、**按模型覆盖 `interfaceType`/`baseUrl`**、**`models` 补丁语义**、**`compat` 三项**、诊断、`apply/save/describe/validate`、`schema` 导出；`apply` 对未改动坏条目容忍、对新增/修改条目写入处拒绝。
- 接口：`openai-chat-completions`、`anthropic-messages` 全量（流式、工具、usage、缓存、deferLoading），并落实 4.10 的"不瞎传"字段集合。
- 传输：超时、取消、有限重试、SSE 分帧。
- 接口方法：`chat` / `chatStream` / `models` / `model` / `providers` / `discover`。
- 网页参考实现（`examples/web`）：零构建 vanilla，`node examples/web/server.mjs` 直接开；三块页面——配置（JSON 编辑 + 校验路径 + 保存 + 脱敏视图）、模型（列表 + 发现候选 + 采用）、对话（流式试跑）。
- 测试：契约测试（本地 mock 上游，含"最小请求字段集合"断言）+ `examples/basic.mjs`。

**验收**

1. 同一个 example 只换配置，能分别打通两个接口类型；
2. 流式工具调用参数拼装正确，`tool_call` 的 `input` 是完整 JSON；
3. 写错一条 model，其余模型仍可用，`validate()` 指出具体路径；
4. `caching: explicit` 在 Anthropic 上断点数量 ≤4 且位置正确；`auto` 一个断点都不发；usage 里缓存 token 照常上报；
5. `deferLoading: true` + `deferredTools` 在 Anthropic 声明上出现 `defer_loading: true`；chat 端点声明该能力直接报错；
6. `apply` 失败时旧配置不变；在途请求不受 `apply` 影响；
7. `describe()` 不含明文密钥；`save()` 后配置里的密钥未被改写；
8. **最小请求自检**：只给 `model` + `messages` 时，chat 端点收到的 body 恰好是 `{model, messages}`，Anthropic 端点恰好是 `{model, messages, max_tokens}`；多一个字段都算不合格；
9. `provider/model` 与 `aliases` 寻址生效；同名模型未消歧时报 `AMBIGUOUS_MATCH` 并列出候选；
10. 一个 provider 下混挂两种协议：按模型的 `interfaceType` 选择正确接口，另一个模型不受影响；
11. `models` 补丁只写 `contextWindow` 时，能力与默认值仍继承家族；id 拼错且没写 `family` → `NO_MATCH`；
12. `compat.systemPrompt: message` 时 system 作为首条消息发出；`compat.omitMaxTokens` 用在 Anthropic 上被写入处拒绝；
13. 网页里改一条配置 → `validate()` 在页面上标出字段路径 → `apply()` 成功 → 下一次请求生效，在途请求不受影响；
14. 网页 `describe()` 看不到明文密钥；`save()` 写回后文件里的密钥未被改写；
15. 网页对话页能流式显示 text 与 tool-call，且 `onConfigChange` 后模型下拉自动更新。

**验收结果**：1–12 由 `tests/*.test.mjs` 覆盖（75 项全绿）；13–15 由网页 API 集成（state/apply/save/chat SSE）与脚本语法检查验证，未做真实浏览器人工点检。

**M2（已实现 ✅）**：`openai-responses`（非流式 + SSE）、`embed` / `rerank`（端点映射可配）、`refresh()`（发现候选进内存缓存）、`maxConcurrent`（按 provider 排队）、strict 模式。
**M3（已实现 ✅，价格除外）**：`image()`、Responses 加密推理回放（`encrypted_content` + item id 原样回传）、`concurrency()` 队列诊断。**价格统计按要求不做**。
**2026-11 官方文档补丁（已实现 ✅）**：Responses `prompt_cache_options` / `prompt_cache_breakpoint`（含 prewarm 空输出）、Anthropic `redacted_thinking` 与空 `thinking` + `signature` 回放、GPT-6.2 Astra 的 1.05M / 128K / 922K 输入上限与 `unsupportedParams` 清单。
**主流配置（已实现 ✅）**：`presets/mainstream-2026-11.config.yaml` 覆盖 DeepSeek V4 / Qwen3.8 / GLM-5.3 / Kimi K3 / MiniMax M3.1 / ERNIE 5 / 混元 / 豆包 / StepFun / GPT-6 / Claude 5.5 / Gemini 4 / Grok 4.7 / Mistral Large 4，含 OpenRouter 与 Ollama；`tests/preset-mainstream.test.mjs` 断言解析与请求体。
**方言矩阵（已实现 ✅）**：`examples/domestic.config.yaml` 用同一套代码覆盖 deepseek / glm（Anthropic 协议 + 自动缓存）/ qwen / kimi 四种思考方言，由 `tests/dialects.test.mjs` 逐字断言。

## 12. 测试策略（已落地）

- 运行器：Node 内置 `node:test` + 本地 `node:http` mock 上游（零测试框架依赖）。
- 配置：三层解析与优先级、`match` 歧义、`models` 补丁、未知字段告警/strict、脱敏。
- 协议：最小请求字段集合（不瞎传）、流式工具参数拼装、Anthropic 事件映射、thinking/缓存/deferLoading。
- 失败路径：401、429 + `Retry-After`、abort、流空闲超时。
- 配置接口：`apply` 事务性、在途快照、`save` 保真、`discover` 不落盘。
- 构建：`tsc -p tsconfig.build.json` 输出 `dist`；`pnpm test` 先构建再 `node --test tests/*.test.mjs`。

## 13. 与现有项目的对齐

| openwebcode / DSH | 本库 |
|---|---|
| `ModelProviderProfile` | `providers[]` |
| `interfaceType` 三值 | 同名字段，同词汇 |
| `model-metadata.ts` 的 `PREFIXES` | `families[]`（数据化，可覆盖） |
| 模型目录手工条目 | `models[]` |
| `promptCaching?: boolean` | `caching: explicit / auto / none`（`true`→explicit，`undefined`→auto） |
| `extraBody` + 保留键 | 同名同义 |
| `ProviderEvent` | `LLMEvent`（同名事件 + `error`） |
| `provider-connection-test` | `discover()` |
| `server-settings.json` | `LLMConfig`（数组 + id） |

迁移注意：OWC 的模型元数据是按前缀硬编码；迁移时把 `PREFIXES` 逐条翻译成 `families[]`，`manual` 条目翻译成 `models[]`。

## 14. LiteLLM 平价与替代边界

**调用面平价**

| LiteLLM 能力 | 本库 | 阶段 |
|---|---|---|
| `completion(model, messages, ...)` | `chat()` | M1 |
| `stream=True` | `chatStream()` | M1 |
| tools / tool_choice / 流式工具拼装 | 同名语义 | M1 |
| `temperature` / `top_p` / `max_tokens` / `stop` / `seed` / `response_format` | 归一字段 + `fieldMap` | M1 |
| `provider/model` 模型名 | 寻址规则 | M1 |
| `api_base` / `api_key` / 自定义 header | provider 档案 | M1 |
| retries / timeout / `Retry-After` | provider `retry` | M1 |
| 用量与缓存 token | `usage` 事件 | M1 |
| 配置校验与诊断 | `validate()` | M1 |
| `embedding()` | `embed()` | M2 |
| `rerank()` | `rerank()` | M2 |
| `image_generation()` | `image()` | M3 |
| 回调 / 日志 | `onRequest` / `onResponse` 钩子 + `onRawEvent` | M2 |
| 成本计算 | 不做（决策 29：不做价格统计） | — |
| fallbacks / 负载均衡 | 不做，库保持透明 | — |
| 预算、虚拟密钥、代理服务 | 不做，不属于库 | — |

**替代边界的明确说法**：本库替代 LiteLLM 的**客户端/统一调用层**（SDK 用法），不替代它的**代理网关**（`litellm --port`、虚拟密钥、预算、限流）。**配置文件不兼容 LiteLLM**：它按 `model_name` + `litellm_params` 平铺，本库按 provider/family/model 分层；迁移的是调用代码，不是 YAML。需要网关时，仍可让 LiteLLM proxy 指向本库所在的进程，或直接绕开 proxy。

**"用户方便"的落点**

- 一份配置多端点，模型名可直接写 `provider/model` 或别名；
- 家族层让新模型零配置可用：只配一个 provider，该端点下任何模型名都能调；
- `chat()` 一条调用拿完整结果，`chatStream()` 一条调用拿事件流；
- 导出 JSON Schema，网页表单可自动生成；
- 错误信息带稳定错误码 + provider/model + 诊断路径。

**"开发者自由"的落点**

- `extra` 任意透传、`fieldMap` 改落名、`extraBody` / `toolFields` / `messageFields` 静态注入；
- `registerInterface()` 注册新接口实现（M2），不需要改库内部；
- `createLLM` 接受对象而非仅文件；`apply()` 可在运行时整体换配置；
- `onRawEvent` 与 `onConfigChange` 让调用方能观察而不被接管。

## 15. 风险与未决

1. **接口枚举的边界**：新厂商若讲新结构（Gemini `contents/parts` 已实现；Ollama NDJSON 尚未），仍需新增一个接口实现（约 150–250 行）。这是"不写死"的物理下限，已用 `fieldMap` / 静态注入点把常见方言差异挡在配置层。
2. **参数透传与归一同名冲突**：规则是归一优先、其余合并、冲突告警；若实际使用中冲突频繁，M2 可加 `paramMap`。
3. **reasoning 回放**：Anthropic 的 `signature`、`redacted_thinking` 与多块顺序已通过 `Thinking.blocks` 保留；仍未建模 reasoning 块与文本/tool 调用之间的原始交错位置。
4. **包名已定**：`@snnh/llm-api`，ESM-only，MIT；尚未发 npm。
5. **发布方式未定**：先本地/git 安装，稳定后再发 npm。
6. **浏览器支持**：Node 24 专属（`node:fs`、`fetch`），不做同构；若以后要，把 `loadConfig`/`save` 拆成独立入口。
7. **"保证替代 LiteLLM"的边界**：调用面平价列在 14 节；`fallbacks` / 负载均衡 / 预算是 LiteLLM **Router/Proxy 层**的能力，已明确不做（决策 24）。需要故障转移的调用方在外层维护候选链并自行重试，本库只保证单次调用透明、可观测、错误可分类。

## 16. 参考

- `snnh/openwebcode` — 服务商档案、`ProviderEvent`、模型元数据与能力词汇。
- `snnh/dsh-llm-service-lite` — 适配器信条（档案即事实、声明即承诺、失败在发生处归类）、配置语义（容忍 + 诊断、快照、凭据引用、发现）。
- [GPT-6.2 Astra 模型页](https://developers.openai.com/api/docs/models/gpt-6.2-astra)：1.05M 上下文、922K 最大输入、128K 最大输出、拒绝 `none`。
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)：`prompt_cache_options.mode` / `ttl` / `prewarm`、`prompt_cache_breakpoint`。
- [Anthropic Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)：`signature`、`display: "omitted"`、`redacted_thinking`。
- [Gemini generateContent](https://ai.google.dev/api/generate-content)：`contents/parts`、`systemInstruction`、`functionDeclarations`、`generationConfig`。
- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)：`thoughtSignature` 必须原样回放（Gemini 3 工具调用会校验）。

## 17. 实现记录（M1–M4 落地差异）

1. **构建形态**：库以 `tsc` 产物 `dist/` 发布，`pnpm build` 是运行测试与示例的前置；发布产物本来就需要构建，测试与示例统一跑 `dist` 以避免源码/产物行为分叉。
2. **`chat()` 不内驱 `chatStream()`**：两者共用事件管道，但 `chat()` 发非流式请求（不带 `stream`），`chatStream()` 才置 `stream: true`——避免"调用方没要流式却收到流式请求"。
3. **合并顺序修正**：`extraBody` 是静态默认，请求级参数必须赢。最终顺序为 `extraBody → 协议 core → 请求透传键 → request.extra`。
4. **`models()` 只列已声明条目**：家族-only 的模型通过 `model(id)` 解析；网页把 `families` 单独展示，避免伪造条目。
5. **`compat.maxTokensField` 在 Anthropic 上生效**（`max_tokens → max_output_tokens` 等）；chat-completions 的落名仍走 `fieldMap.maxTokens`。
6. **并发队列**：`maxConcurrent` 按 provider 排队，`concurrency()` 暴露 active / queued / peak。
7. **已补齐**：`openai-responses`、`embed` / `rerank` / `image`、`refresh()`、`maxConcurrent` + `concurrency()` 队列诊断、Responses 加密推理回放、国内方言矩阵、主流模型 preset（2026-11）。**价格统计按决策 29 不做**。仍未做：真实浏览器人工点检、真实供应商联调。
8. **家族匹配改为最长匹配优先**：`glm-5.3` 与 `glm-5` 同时命中时取更具体者，同等具体度才报 `AMBIGUOUS_MATCH`。
9. **思考深度**：`thinking` / `fixed` 在 chat 上随 `reasoning_effort` 下发；Anthropic 的 adaptive/fixed/extended 在给了 `effort` 时下发 `output_config.effort`。
10. **deferLoading 覆盖 chat + anthropic**：DeepSeek / Kimi 的动态工具加载走 chat 线，`defer_loading` 同样生效。
11. **GPT-6.2 适配**：`gpt-6.2-astra` / `gpt-6.2-sol` 按官方模型页声明 1.05M / 128K、`thinking: [enabled]`、`effort: low..max`；`unsupportedParams` 按官方清单记录 `temperature` / `topP` / `top_p` / `topLogprobs` / `top_logprobs` / `logprobs`，只作建议、不拦截；用户坚持传就原样发送，上游 400 原样返回。`async: true` 工具在 Responses 线上原样下发并回读。
12. **6.2 能力**：WebSocket mid-turn steering 尚未封装；`configurationUpdates`、`promptCacheOptions`（`mode` / `ttl` / `prewarm`）与显式 `promptCacheBreakpoint` 已支持。推理项被服务端丢弃的规则写在 README，调用方需保持前缀稳定、完整回放输出项。
13. **网页 13–15 的验证方式**：`/api/state`、`/api/apply`（掩码密钥还原）、`/api/save`、`/api/chat` SSE 已用 curl 集成验证；页面脚本只做了语法检查，未在真实浏览器里逐项点检。
14. **Responses 工具项 round-trip**：`function_call` 输出补 `itemId`（来自 `item.id`），异步工具回放时与 `call_id` 一起原样带回；非流式与 SSE 都有断言。
15. **发布包自检**：`package.json` 的 `files` 显式包含 `dist`、`examples` 与 `CHANGELOG.md`，`exports` 带 `types` 条件；`tests/package.test.mjs` 用 `npm pack --dry-run` 断言 dist、声明、示例、CHANGELOG 与 LICENSE 都在包里。
16. **强制模式**：`force` 按 `model > family > provider > root` 取最具体值；`true` 时 `validateRequest` 跳过图片/thinking 校验，三个适配器跳过 `tools: false` 与未声明 `deferLoading` 的拒绝，但 `cacheBreakpoints`/异步工具的 wire 校验与配置诊断不变。
17. **`configurationUpdates`**：仅在 Responses 线允许，按顺序生成 `{type:'configuration_update', ...}` 插在最新一条 user 输入前；非 Responses 结构性拒绝，`force` 不绕过。
18. **DeepSeek 适配**：chat 线在 `reasoningContent: true` 时把 `message.reasoning.text` 写回 `reasoning_content`（工具调用多轮必需）；Responses 线新增 `deepseek-flash` / `deepseek-v4-pro-responses`，支持 `reasoning.effort`、`reasoning_text` 的解析/回放，不发送 `include`。
19. **Responses `jsonMode`**：`jsonMode: true` 落为 `text: { format: { type: 'json_object' } }`；完整 schema 仍走 `extra.text.format`。
20. **末尾 system 更新**：Anthropic 适配器把 `role:'system'` 的 `toolChanges` 映射为 `tool_addition`/`tool_removal`（引用已声明工具），把 `outputConfig.effort` 映射为逐消息 `output_config`，并按需合并 `mid-conversation-tool-changes-2026-07-01` / `mid-conversation-output-config-2026-07-01` beta 头。
21. **redacted thinking**：Anthropic 的 `redacted_thinking` 块映射为 `thinking.redacted` 与 `thinking.blocks`；回放时按 `blocks` 原样发回。`display: "omitted"` 产生的空 `thinking` + `signature` 也会回放。
22. **prompt cache**：Responses `promptCacheOptions` 映射为 `prompt_cache_options`，`promptCacheKey` 映射为 `prompt_cache_key`，文本块的 `promptCacheBreakpoint` 映射为 `prompt_cache_breakpoint`；其他 wire 与不支持的值结构性拒绝。
23. **Gemini 原生线**：`contents/parts`、`systemInstruction`、`functionDeclarations`、`generationConfig` 由适配器映射；`thoughtSignature` 通过 `ContentPart.signature` / `ToolCall.signature` / `textSignature` 保留并回放，`functionCall.id` 通过 `ToolCall.providerId` 回放到 `functionResponse.id`。`system` / `systemSuffix` 与所有 system 消息折进 `systemInstruction`，原生线没有会话中 system 语义；延迟/异步工具、显式缓存、`enable_thinking`、`effort_only + disabled`、`streamFunctionCallArguments` / built-in tools 结构性拒绝。preset 同时保留 `google` OpenAI 兼容线与 `google-native` 原生线。
