# Changelog

## 0.1.0 — 2026-11-21

首个可运行版本。

### 配置

- 三层配置：`providers` / `families` / `models`，支持 JSON 与可选 YAML。
- 模型寻址：`provider/model`、模型 id、别名、家族前缀/正则回退。
- 配置接口：`schema`、`describe`、`validate`、`apply`、`save`、`onConfigChange`。
- 声明式能力校验：图片、thinking、tools、deferLoading，支持 `force` 覆盖。
- 内置 `presets/mainstream-2026-11.config.yaml`：18 端点 / 35 家族 / 24 模型。

### 接口

- `openai-chat-completions`：流式/非流式、工具、usage、thinking、`reasoning_content`。
- `anthropic-messages`：流式/非流式、thinking 签名与多块 `redacted_thinking` 回放、末尾 system 工具/effort 更新（含工具名本地校验）、显式缓存。
- `openai-responses`：流式/非流式、工具、异步工具、`configurationUpdates`、`promptCacheOptions` / `promptCacheKey` / 显式断点、加密与纯文本推理回放。
- `embed` / `rerank` / `image`、模型发现与刷新、按 provider 并发队列。

### 传输与错误

- `fetch` 单一路径、超时、取消、有限重试、`Retry-After`。
- 稳定错误码：凭据、限流、配置、上游、空响应、中止等。

### 测试

- 67 个 `node:test` 契约测试，全部使用本地 mock 上游。
