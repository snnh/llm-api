# @snnh/llm-api

配置驱动的轻量 LLM 客户端：**厂商与模型写在配置里，不在代码里**。定位是替代 LiteLLM / pi-ai 的调用层，而不是替代它们的代理网关。

- 三层配置：`providers`（端点/协议/凭据）→ `families`（模型家族回退）→ `models`（单模型差异）
- 加一个模型：改配置；加一个同协议厂商：加一条 provider
- 统一 `chat()` / `chatStream()`；流式工具调用、thinking、usage 归一
- 配置接口：`schema` / `describe` / `validate` / `apply` / `save` / `onConfigChange` / `discover`
- 参数克制：未提供、未声明、非必需的字段一律不发

详细设计与决策记录见 [PLAN.md](./PLAN.md)，版本记录见 [CHANGELOG.md](./CHANGELOG.md)。

> 当前尚未发布 npm；先按本地路径或 git 安装，发布后再补 `@snnh/llm-api` 的 npm 安装说明。

## 安装与构建

```sh
pnpm install
pnpm build          # tsc -> dist（库以 dist 发布，测试/示例都跑 dist）
```

## 快速开始

```yaml
version: 1
providers:
  - id: deepseek
    interfaceType: openai-chat-completions
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
families:
  - id: deepseek
    match: ['deepseek-']
    provider: deepseek
    contextWindow: 1000000
    capabilities: { tools: true, thinkingStyle: thinking }
```

```ts
import { createLLM, loadConfig } from '@snnh/llm-api';

const config = loadConfig('llm-api.config.yaml');
const llm = createLLM(config, { source: 'llm-api.config.yaml' });

const result = await llm.chat({
  model: 'deepseek-reasoner',            // 或 'deepseek/deepseek-chat'
  system: '你是一个简洁的助手。',
  messages: [{ role: 'user', content: '你好' }],
});

for await (const event of llm.chatStream({ model: 'deepseek-reasoner', messages: [] })) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
}
```

## 配置三层

| 层 | 作用 | 关键字段 |
|---|---|---|
| `providers[]` | 怎么连 | `interfaceType`、`baseUrl`、`auth` / `apiKeyEnv`、`headers`、`caching`、`includeUsage`、`extraBody`、`toolFields`、`fieldMap`、`discover` |
| `families[]` | 没写 model 时用什么 | `match`（前缀/正则）、`contextWindow`、`maxOutput`、`defaults`、`capabilities` |
| `models[]` | 单个模型的差异 | `upstream`、`aliases`、`interfaceType`、`capabilities`、`defaults` 等 |

解析顺序：`model > family > provider`。`models` 是可选的补丁：标量替换、映射字段按 key 合并、`null` 删除。

能力声明（`capabilities`）：`modalities`、`tools`、`thinking`、`thinkingStyle`（沿用 openwebcode 六值）、`effort`（仅 UI 提示，不映射）、`unsupportedParams`（模型可能拒绝的请求字段，仅建议）、`reasoningContent`、`outputConfigEffort`（Anthropic：thinking 形态也发 `output_config.effort`）、`deferLoading`、`parallelToolCalls`、`responsesEncryptedReplay`。默认按声明校验：未声明图片输入却带图、思考模式不在列表会报错；`unsupportedParams` 不拦截——参数原样下发，上游错误原样返回。

### 强制模式

配置根、provider、family、model 都可写 `force: true`，最具体层优先。开启后**跳过运行时的能力声明校验**（图片、`thinking`、`tools`、`deferLoading`），按用户设置下发，模型拒绝时由上游报错：

```yaml
force: true              # 整份配置
# 或
models:
  - id: my-model
    force: true          # 只放开这一条
```

强制模式不绕过配置 schema、wire 结构校验（`cacheBreakpoints` 只能 Anthropic、异步工具只能 Responses）和缓存/思考形态等配置期诊断；`thinking` 的字段映射仍由 `thinkingStyle` 决定。

Responses 线改思考深度用 `configurationUpdates`，不必改请求级 `reasoning.effort`：

```ts
await llm.chat({
  model: 'gpt-6.2-astra',
  messages: [{ role: 'user', content: '继续分析失败模式。' }],
  configurationUpdates: [{ reasoning: { effort: 'high' } }],
});
```

GPT-5.6 及以后在 Responses 上用 `promptCacheOptions` 控制缓存生命周期；`mode: 'explicit'` 时可在文本块上放断点，块级 `ttl` 覆盖请求级值：

```ts
await llm.chat({
  model: 'gpt-6.2-astra',
  messages: [{
    role: 'user',
    content: [{
      type: 'text',
      text: '稳定前缀',
      promptCacheBreakpoint: { mode: 'explicit', ttl: '12h' },
    }],
  }],
  promptCacheOptions: { mode: 'explicit', ttl: '30m' },
  promptCacheKey: 'tenant:42',
});
```

`ttl` 只接受 `'30m'` / `'12h'`；`prewarm: true` 用于只写缓存、不生成输出；`promptCacheKey` 用于独立缓存记账。`promptCacheOptions`、`promptCacheBreakpoint` 与 `promptCacheKey` 都只在 `openai-responses` 上可用，其他 wire 会结构性拒绝。

DeepSeek 的 Responses 线用请求级 effort 切换，并回放纯文本 reasoning：

```ts
const llm = createLLM(loadConfig('presets/mainstream-2026-11.config.yaml'));
await llm.chat({
  model: 'deepseek-flash',           // 或 deepseek-v4-pro-responses
  messages: [{ role: 'user', content: '继续。' }],
  effort: 'max',
});
```

### 会话末尾更新工具/思考

Anthropic Messages 线支持在 `messages` 末尾追加 `role: 'system'` 的更新消息；`tool_addition` / `tool_removal` 引用的是请求 `tools` 里已声明的工具，`output_config.effort` 改变后续轮次的思考强度：

```ts
await llm.chat({
  model: 'deepseek-flash-anthropic',
  messages: [
    { role: 'user', content: '检查天气，然后查数据库。' },
    {
      role: 'system',
      content: '从现在开始只用数据库工具。',
      toolChanges: { remove: ['get_weather'], add: ['db_query'] },
      outputConfig: { effort: 'low' },
    },
    { role: 'assistant', content: '好的。' },
  ],
  // 两个工具都必须先在这里声明
  tools: [
    { name: 'get_weather', parameters: { type: 'object' } },
    { name: 'db_query', parameters: { type: 'object' } },
  ],
});
```

适配器会自动带上 `mid-conversation-tool-changes-2026-07-01` 和 `mid-conversation-output-config-2026-07-01` beta 头；当前只在 `anthropic-messages` 上生效。

Anthropic 的多个 `thinking` / `redacted_thinking` 块会按顺序保存在 `Thinking.blocks` 中，并可原样回放；空 `thinking` + `signature` 也会保留。仍未建模的是 reasoning 块与文本/tool 调用之间的原始交错位置——`Message.reasoning` 仍是一个聚合对象。

## 请求字段与 wire 归属

| 字段 | 适用 wire | 说明 |
|---|---|---|
| `configurationUpdates` | `openai-responses` | 在最新 user 输入前插入 `configuration_update`，会话中改 effort/format |
| `promptCacheOptions` | `openai-responses` | `mode` / `ttl` / `prewarm` → `prompt_cache_options` |
| `promptCacheKey` | `openai-responses` | 独立缓存记账 → `prompt_cache_key` |
| `promptCacheBreakpoint` | `openai-responses` | 文本内容块上的显式断点 → `prompt_cache_breakpoint` |
| `cacheBreakpoints` | `anthropic-messages` + `caching: explicit` | 按消息 id 选择 `cache_control` 断点，最多 4 个 |
| `role: 'system'` 的 `toolChanges` / `outputConfig` | `anthropic-messages` | 末尾更新工具可用性与逐消息 effort |
| `deferredTools` | chat-completions / anthropic-messages | 配合 `capabilities.deferLoading` 发 `defer_loading` |
| `async: true` 工具 | `openai-responses` | 异步工具声明与回放 |
| `serverWebSearch` | `openai-responses` | 在 `tools` 末尾附加内置 `{"type":"web_search"}` |
| `headers` | 全部 | 请求级额外 header（如动态 User-Agent） |
| `rawBody` | 全部 | 调用方预构造的协议 body；认证/重试/超时/事件解析仍由库处理 |

wire 不支持的结构会抛 `UNSUPPORTED_FEATURE`，`force: true` 不绕过这些结构性校验。

## 事件与增量边界

`chatStream()` 统一事件：`text_delta` / `text_end` / `thinking_delta` / `thinking_end` /
`tool_call_delta` / `tool_call` / `server_tool` / `web_search_call` / `usage` / `done`。

- `thinking_end.item`：Responses 返回的完整 reasoning item，适合原样回放；`signature` 保留 item id。
- `text_end.itemId` / `phase`：Responses message item 的权威 id/phase，调用方可自行编码成签名落盘。
- `server_tool` 是实时活动；`web_search_call` 携带完整 item，按「Pass back as-is」回放。
- `rawBody` 适合宿主已有协议构造器时只接管传输层；库仍负责 SSE 分帧、idle 超时、事件上限、
  HTTP 错误分类与取消。

## 不瞎传

1. `undefined` / `null` / 空数组 / 空对象不写进请求；
2. 没声明的不发：`caching: auto|none` 不打 `cache_control`、未声明 `thinkingStyle` 不发思考参数、`includeUsage: false` 不发 `stream_options`；
3. 非必需的不发：`max_tokens` 只在请求或 `defaults.maxTokens` 给出时发；`temperature` / `top_p` / `stop` / `seed` / `response_format` 未给就不发；
4. Anthropic 的 `max_tokens` 按 `请求 → defaults → maxOutput` 取值，三者皆无则 `INVALID_REQUEST`，不臆造默认值；
5. `effort` / `thinking` / `thinkingBudgetTokens` 原样下发，库不做档位映射。

## 配置接口

```ts
llm.schema        // JSON Schema，可直接喂表单生成器
llm.describe()    // 当前配置，密钥脱敏
llm.validate(next) // 带 JSON 路径的诊断，不动线上配置
llm.apply(next)   // 事务式热替换：失败则旧配置不变；在途请求保持旧快照
await llm.save()  // 原子写回 source，保留不认识的字段与原始密钥
llm.onConfigChange(fn)
await llm.discover('deepseek') // 候选元数据，不落盘
await llm.refresh('deepseek')  // 候选进内存缓存，models() 能看到
llm.concurrency()              // { active, queued, peak }，按 provider
```

## 网页参考实现

```sh
pnpm build
pnpm web        # http://127.0.0.1:8788
# 或指定配置：node examples/web/server.mjs --config path/to/config.yaml --port 8788
```

三块页面：配置（JSON 编辑 + 校验路径 + 应用 + 写回 + 脱敏）、模型（声明列表 + 家族回退 + 端点发现/加入草稿）、对话（流式 text/thinking/tool/usage）。网页由 `describe()` 拿脱敏配置，保存时服务端把掩码密钥还原，不会写坏文件。

## 示例与测试

```sh
export DEEPSEEK_API_KEY=...
pnpm example    # 流式打印，展示生效模型视图
pnpm test       # 67 个契约测试（node:test + 本地 mock 上游）
node --test tests/dialects.test.mjs   # 国内模型方言矩阵：只改配置
```

## 方言矩阵

`examples/domestic.config.yaml` 是同一套代码适配四家方言的配置样例：

| 家族 | 协议 | 思考写法 | 缓存 |
|---|---|---|---|
| deepseek | chat-completions | `thinking: {type}` | 端点自动 |
| glm | anthropic-messages | `thinking: {type}` | 服务端自动（不发 `cache_control`） |
| qwen | chat-completions | 顶层 `enable_thinking` | 端点自动 |
| kimi-k3 / kimi-for-coding | chat-completions | `reasoning_effort`（原样）/ 恒开 | 端点自动 |

`tests/dialects.test.mjs` 用同一份配置打 mock 上游，逐字断言请求体——这就是"加模型不改代码"的证据。

## 内置主流配置（2026-11-21 核对）

`presets/mainstream-2026-11.config.yaml`：18 个端点、35 个家族、24 个旗舰模型条目，开箱即用。

```ts
const config = loadConfig('presets/mainstream-2026-11.config.yaml');
const llm = createLLM(config, { source: 'presets/mainstream-2026-11.config.yaml' });
await llm.chat({ model: 'claude-opus-5-5', messages: [...] });
```

覆盖与关键事实（仅声明已核对的项）：

| 厂商 | 当前型号 | 上下文 / 输出 | 方言 |
|---|---|---|---|
| DeepSeek | chat：v4-pro / v4.1-flash；Responses：deepseek-flash / v4-pro-responses；Anthropic：*-anthropic | 1M / 384K | chat：`thinking:{type}` + `reasoning_content` 回放；Responses：`reasoning.effort` + plain-text reasoning；Anthropic：`thinking` + `output_config.effort` + 末尾工具变更 |
| Qwen | qwen3.8-max / qwen3.8-flash / qwen3.7 | 1M / 64K | 顶层 `enable_thinking` |
| 智谱 GLM | glm-5.3 / 5.2 / 5 | 1M / 128K | Anthropic 协议；5.3 思考恒开（`output_config.effort`），服务端自动缓存 |
| Kimi | kimi-k3 / k2.6 / k2.7 / for-coding | 1M、256K / 128K | k3 只收 `reasoning_effort`，动态工具加载 |
| MiniMax | M3.1-Flash / M3 / M2 | 1M、256K / 128K | `max_completion_tokens`；M3.1 用 `reasoning_effort` |
| 百度 | ernie-5 / 4.5-vl | 256K / 64K | `thinking:{type}`，视频输入 |
| 腾讯 / 豆包 / 阶跃 | hy3 / hy4、doubao-*、step-* | 256K / 64K | family 前缀匹配，具体 ID 用 `discover()` 取 |
| OpenAI | gpt-6.2-astra / 6.2-sol、6-astra / 6.1-sol / 6-luna | 1.05M / 128K | Responses；`reasoning.effort`（6.2 不收 `none` / `minimal`，且建议移除 `temperature` / `top_p` / `top_logprobs`）+ `prompt_cache_options` + 加密推理回放 + 异步工具 |
| Anthropic | opus / sonnet / haiku 5.5、fable 5.2 | 1M / 128K | adaptive 思考 + `output_config.effort`，显式缓存断点 |
| Google | gemini-4-argon / gemini-3.8-flash | 1M / 64K | OpenAI 兼容端点；思考级别用 `extra: { thinking_level }` |
| xAI | grok-4.7 | 500K / 64K | `reasoning_effort` |
| Mistral | mistral-large-4 | 1M / 64K | `max_completion_tokens` |
| 聚合 / 本地 | OpenRouter、Ollama | 按家族 | OpenRouter 需显式 `provider: 'openrouter'` |

注意：

- 上下文/输出是核对日的官方值；不确定的取保守值并写在注释里，生产前用 `llm.model(id)` 核对。
- **不做价格统计**，preset 里没有任何价格字段。
- OpenRouter 的路由名形如 `anthropic/claude-opus-5-5`，与直连 `provider/model` 寻址冲突，必须显式传 `provider: 'openrouter'`。
- Ollama 用占位 key（本地服务通常不校验，但兼容层要求非空）。
- 模型下线只改 `match` / `models`，不用改代码。
- **GPT-6.2**：工具调用只能走 Responses，preset 的 `openai` 端点即 Responses；`none` / `minimal` 会被服务端 400，preset 只声明 `low`–`max`；官方要求 reasoning effort 非 `none` 时移除 `temperature` / `top_p` / `top_logprobs`（Chat 还要移除 `logprobs`），本地只把这些写进 `unsupportedParams` 建议、不拦截，原样发给上游，400 也原样返回。
- **GPT-6.2 的推理项**会因前缀编辑、`safety_identifier` 变化或跨模型家族被服务端丢弃；多轮请保持前缀不变并回放完整输出项。会话中改思考深度用 `configurationUpdates`（插在最新 user 消息前）；prompt cache 生命周期用 `promptCacheOptions`。WebSocket 的 mid-turn steering 尚未封装。
- **DeepSeek 没有 `configuration_update`**：Responses API 是 stateless 的，input item 里的其他类型会被忽略；改思考深度直接改请求级 `reasoning.effort`（`none` / `low` / `high` / `max`）。**Anthropic Messages 线**则用末尾 `role: 'system'` 消息更新工具与逐消息 effort。`deepseek-flash` 支持图片，`deepseek-v4-pro` 不支持。

## 支持范围

| 接口 | 状态 |
|---|---|
| `openai-chat-completions` | ✅ 流式/非流式、tools、usage、thinking、includeUsage |
| `anthropic-messages` | ✅ 流式/非流式、tools、thinking 签名与多块 `redacted_thinking` 回放、末尾 system/tool/effort 更新、explicit/auto 缓存、deferLoading |
| `openai-responses` | ✅ 非流式 + SSE、function_call、异步工具（`async: true`）、`configurationUpdates`、`promptCacheOptions` / `promptCacheKey` / 显式断点、加密/纯文本推理回放 |
| embeddings / rerank / images | ✅ 端点映射可配（`embed` / `rerank` / `image`） |
| 模型发现 / 刷新 / 并发 | ✅ `discover()`、`refresh()`、`maxConcurrent` |

不做：HTTP 网关、内置 UI、fallback/负载均衡、预算与虚拟密钥（这些属于 LiteLLM Router/Proxy 层）；**不做价格统计**（不建 pricing 字段、无成本估算 API）。
