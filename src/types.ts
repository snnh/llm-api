/** Wire protocols. M1 implements the first two. */
export type InterfaceType =
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'openai-responses';

export type CachingMode = 'explicit' | 'auto' | 'none';
export type Modality = 'text' | 'image' | 'video';
export type ThinkingMode = 'enabled' | 'disabled' | 'adaptive';
export type ThinkingStyle =
  | 'thinking'
  | 'enable_thinking'
  | 'effort_only'
  | 'fixed'
  | 'extended'
  | 'adaptive';

export interface Capabilities {
  modalities?: Modality[];
  tools?: boolean;
  /** UI hint only: the library never maps or validates effort values. */
  effort?: string[] | false;
  /** Advisory only: request keys the model may reject (e.g. sampling params on GPT-6.2). */
  unsupportedParams?: string[];
  thinking?: ThinkingMode[];
  thinkingStyle?: ThinkingStyle;
  /** chat: replay `reasoning_content`; responses: replay plain-text reasoning items. */
  reasoningContent?: boolean;
  /** Anthropic messages: allow top-level effort for `thinking` style via output_config. */
  outputConfigEffort?: boolean;
  responsesEncryptedReplay?: boolean;
  deferLoading?: boolean;
  parallelToolCalls?: boolean;
}

export interface Defaults {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
}

export interface AuthConfig {
  header?: string;
  scheme?: string;
  env?: string;
}

export interface RetryPolicy {
  maxAttempts?: number;
  statuses?: number[];
}

export interface DiscoverConfig {
  path?: string;
  readPath?: string;
}

export interface EndpointMapping {
  path?: string;
  readPath?: string;
}


export interface Compat {
  systemPrompt?: 'field' | 'message';
  maxTokensField?: string;
  omitMaxTokens?: boolean;
}

export interface ProviderConfig {
  id: string;
  enabled?: boolean;
  /** Skip runtime capability checks for this provider (see LLMConfig.force). */
  force?: boolean;
  interfaceType: InterfaceType;
  displayName?: string;
  baseUrl?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: AuthConfig;
  apiKey?: string;
  apiKeyEnv?: string;
  caching?: CachingMode;
  includeUsage?: boolean;
  extraBody?: Record<string, unknown>;
  toolFields?: Record<string, unknown>;
  messageFields?: Record<string, unknown>;
  fieldMap?: Record<string, string>;
  family?: string;
  maxConcurrent?: number;
  streamIdleTimeoutMs?: number;
  connectTimeoutMs?: number;
  retry?: RetryPolicy;
  discover?: DiscoverConfig;
  embed?: EndpointMapping;
  rerank?: EndpointMapping;
  image?: EndpointMapping;
  errors?: Record<string, string>;
  compat?: Compat;
}

export interface FamilyConfig {
  id: string;
  match?: string[];
  /** Skip runtime capability checks for this family; overrides provider/root. */
  force?: boolean;
  provider?: string;
  interfaceType?: InterfaceType;
  baseUrl?: string;
  contextWindow?: number;
  maxOutput?: number;
  defaults?: Defaults;
  capabilities?: Capabilities;
  caching?: CachingMode;
  extraBody?: Record<string, unknown>;
  toolFields?: Record<string, unknown>;
  messageFields?: Record<string, unknown>;
  fieldMap?: Record<string, string>;
  compat?: Compat;
}

export interface ModelConfig {
  id: string;
  aliases?: string[];
  /** Skip runtime capability checks for this model; most specific force wins. */
  force?: boolean;
  enabled?: boolean;
  provider?: string;
  family?: string;
  upstream?: string;
  interfaceType?: InterfaceType;
  baseUrl?: string;
  contextWindow?: number;
  maxOutput?: number;
  defaults?: Defaults;
  capabilities?: Capabilities;
  caching?: CachingMode;
  extraBody?: Record<string, unknown>;
  toolFields?: Record<string, unknown>;
  messageFields?: Record<string, unknown>;
  fieldMap?: Record<string, string>;
  compat?: Compat;
}

export interface GlobalDefaults {
  caching?: CachingMode;
  connectTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  retry?: RetryPolicy;
}

export interface LLMConfig {
  version: 1;
  /** Trust user settings: skip runtime capability checks (wire structure still enforced). */
  force?: boolean;
  defaults?: GlobalDefaults;
  providers: ProviderConfig[];
  families?: FamilyConfig[];
  models?: ModelConfig[];
}

/* ------------------------------------------------------------------ messages */

export interface PromptCacheBreakpoint {
  mode: 'explicit';
  /** Overrides the request-level `promptCacheOptions.ttl` for this block. */
  ttl?: '30m' | '12h';
}

export type ContentPart =
  | { type: 'text'; text: string; promptCacheBreakpoint?: PromptCacheBreakpoint }
  | { type: 'image'; data: string; mediaType: string };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  itemId?: string;
  /** Responses API: the call was issued asynchronously. */
  async?: boolean;
}

export type ThinkingBlock =
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

export interface Thinking {
  text: string;
  signature?: string;
  /** Anthropic: last/only encrypted `redacted_thinking` block, replayed verbatim. */
  redacted?: string;
  /** Anthropic: ordered thinking / redacted_thinking blocks, used for exact replay. */
  blocks?: ThinkingBlock[];
  /** Responses API: provider-encrypted reasoning payload, replayed verbatim. */
  encrypted?: string;
  /** Responses API: complete reasoning item as returned by the endpoint (id/status/
   * summary/content/encrypted_content). Use this when exact replay matters. */
  item?: Record<string, unknown>;
}

export interface PromptCacheOptions {
  /** Responses API only. `explicit` requires content-level cache breakpoints. */
  mode?: 'implicit' | 'explicit';
  /** Responses API only: minimum cache lifetime. */
  ttl?: '30m' | '12h';
  /** Responses API only: prepare the cache without generating output. */
  prewarm?: boolean;
}


export type Message =
  | { role: 'user'; id?: string; content: string | ContentPart[] }
  | {
      role: 'assistant';
      id?: string;
      content?: string | ContentPart[];
      toolCalls?: ToolCall[];
      reasoning?: Thinking;
    }
  | {
      role: 'tool';
      id?: string;
      toolCallId: string;
      name?: string;
      content: string | ContentPart[];
      isError?: boolean;
    }
  | {
      role: 'system';
      id?: string;
      /** Empty for an effort-only update. */
      content?: string | ContentPart[];
      /** Anthropic beta: reference tools declared in `tools`. */
      toolChanges?: { add?: string[]; remove?: string[] };
      /** Anthropic beta: per-message output_config.effort. */
      outputConfig?: { effort?: string };
    };

export interface ToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  deferLoading?: boolean;
  /** Responses API only: continue working while the tool runs. */
  async?: boolean;
}

/** Responses API: change reasoning effort / output format without editing the prefix. */
export interface ConfigurationUpdate {
  reasoning?: { effort?: string };
  text?: { format?: Record<string, unknown> };
}

export interface ChatRequest {
  /** Model id, alias, or `provider/model`. */
  model: string;
  provider?: string;
  system?: string;
  /** Dynamic system tail: stable prefix must stay byte-identical for prompt caching. */
  systemSuffix?: string;
  messages: Message[];
  tools?: ToolDef[];
  deferredTools?: string[];
  thinking?: ThinkingMode;
  /** Sent verbatim; the library has no effort mapping. */
  effort?: string;
  thinkingBudgetTokens?: number;
  /** Responses API only: inserted before the latest user message. */
  configurationUpdates?: ConfigurationUpdate[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stop?: string[];
  seed?: number;
  jsonMode?: boolean;
  cacheBreakpoints?: string[];
  /** Responses API only: map to `prompt_cache_options`. */
  promptCacheOptions?: PromptCacheOptions;
  /** Responses API only: separate cache accounting key. */
  promptCacheKey?: string;
  /** Responses API only: append the built-in `web_search` tool. */
  serverWebSearch?: boolean;
  /** Extra request headers for this call (e.g. a dynamic User-Agent). */
  headers?: Record<string, string>;
  /** Pre-built protocol body. When set the adapter sends it verbatim instead of
   * mapping `system`/`messages`/`tools`; auth, retry, timeout and event parsing
   * still go through the library. Callers are responsible for protocol validity. */
  rawBody?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Any other key is passed through to the request body verbatim. */
  [key: string]: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';

export type LLMEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'text_end';
      text: string;
      /** Opaque caller-owned signature (e.g. an OWC message item id). */
      signature?: string;
      /** Responses API: the authoritative `message` item id. */
      itemId?: string;
      /** Responses API: the message item phase, when provided by the endpoint. */
      phase?: string;
    }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'thinking_end';
      text: string;
      signature?: string;
      redacted?: string;
      encrypted?: string;
      block?: ThinkingBlock;
      /** Responses API: complete reasoning item, suitable for exact replay. */
      item?: Record<string, unknown>;
    }
  | { type: 'tool_call_delta'; id: string; name?: string; argumentsDelta: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; itemId?: string; async?: boolean }
  | { type: 'server_tool'; tool: string; phase: 'start' | 'update' | 'end' }
  | { type: 'web_search_call'; item: Record<string, unknown> }
  | ({ type: 'usage' } & Usage)
  | { type: 'done'; stopReason: StopReason }
  | { type: 'error'; error: import('./errors.ts').LLMError };

export interface ChatResult {
  text: string;
  thinking?: Thinking;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
}

/* ------------------------------------------------------------- config views */

export type DiagnosticCode =
  | 'INVALID_TYPE'
  | 'INVALID_URL'
  | 'UNKNOWN_FIELD'
  | 'UNRESOLVED_REF'
  | 'DUPLICATE_ID'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'UNSUPPORTED_FEATURE'
  | 'INVALID_VALUE'
  | 'INVALID_CONFIG'
  | 'UNKNOWN_MODEL';

export interface Diagnostic {
  path: string;
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
}

export type EntryState = 'ok' | 'error';

export interface ModelView {
  id: string;
  provider: string;
  /** Effective force flag: runtime capability checks are skipped. */
  force: boolean;
  upstream: string;
  interfaceType: InterfaceType;
  contextWindow: number;
  maxOutput: number;
  capabilities: Capabilities;
  defaults: Defaults;
  caching: CachingMode;
  enabled: boolean;
  /** Where the effective entry came from. */
  source: 'model' | 'family' | 'provider' | 'discovered';
  state: EntryState;
  diagnostics: Diagnostic[];
}

export interface ProviderView {
  id: string;
  interfaceType: InterfaceType;
  baseUrl?: string;
  enabled: boolean;
  family?: string;
  state: EntryState;
  diagnostics: Diagnostic[];
}

export interface ModelCandidate {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
}

export interface CreateOptions {
  env?: Record<string, string | undefined>;
  /** Override the global fetch implementation (tests / host integration). */
  fetch?: typeof fetch;
  /** Unknown fields become errors instead of warnings. */
  strict?: boolean;
  /** File the config was loaded from; `save()` writes back to it. */
  source?: string;
}

export interface ApplyResult {
  ok: boolean;
  changed: string[];
  diagnostics: Diagnostic[];
}

export interface ChangeEvent {
  providers: string[];
  families: string[];
  models: string[];
}

export interface LLM {
  chat(req: ChatRequest): Promise<ChatResult>;
  chatStream(req: ChatRequest, opts?: ChatStreamOptions): AsyncIterable<LLMEvent>;
  models(): ModelView[];
  model(id: string, provider?: string): ModelView | undefined;
  providers(): ProviderView[];
  describe(): unknown;
  validate(next?: unknown): Diagnostic[];
  apply(next: unknown): ApplyResult;
  save(): Promise<void>;
  onConfigChange(fn: (change: ChangeEvent) => void): () => void;
  discover(providerId: string): Promise<ModelCandidate[]>;
  refresh(providerId: string): Promise<ModelCandidate[]>;
  embed(request: EmbedRequest): Promise<EmbedResult>;
  rerank(request: RerankRequest): Promise<RerankResult>;
  image(request: ImageRequest): Promise<ImageResult>;
  concurrency(): Record<string, ConcurrencyStats>;
  readonly schema: unknown;
}

export interface EmbedRequest {
  model: string;
  provider?: string;
  input: string | string[];
  dimensions?: number;
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface EmbedResult {
  vectors: number[][];
  usage: Usage;
}

export interface RerankRequest {
  model: string;
  provider?: string;
  query: string;
  documents: string[];
  topN?: number;
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface RerankResult {
  results: { index: number; score: number; document?: string }[];
  usage: Usage;
}

export interface ImageRequest {
  model: string;
  provider?: string;
  prompt: string;
  size?: string;
  n?: number;
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface ImageResult {
  images: { url?: string; b64?: string; mediaType?: string }[];
  usage: Usage;
}

export interface ConcurrencyStats {
  active: number;
  queued: number;
  peak: number;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  /** Debug hook: raw SSE frames (or raw JSON body for non-stream calls). */
  onRawEvent?: (raw: string) => void;
}
