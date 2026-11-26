import { LLMError } from './errors.ts';
import {
  ConfigState,
  configJsonSchema,
  loadConfig,
  parseConfig,
  saveConfigFile,
  type EffectiveModel,
} from './config.ts';
import { anthropicAdapter } from './anthropic.ts';
import { geminiAdapter } from './gemini.ts';
import { openaiChatAdapter } from './openai-chat.ts';
import { responsesAdapter } from './responses.ts';
import { selectArray, selectPath } from './paths.ts';
import { buildHeaders, resolveApiKey } from './params.ts';
import { requestJson } from './transport.ts';
import { joinUrl, num, obj, str } from './adapter.ts';
import type {
  ApplyResult,
  ChangeEvent,
  ChatRequest,
  ChatResult,
  ChatStreamOptions,
  CreateOptions,
  Diagnostic,
  LLM,
  LLMEvent,
  LLMConfig,
  ModelCandidate,
  ModelView,
  ProviderConfig,
  ProviderView,
  ThinkingBlock,
  ToolCall,
  Usage,
  EmbedRequest,
  EmbedResult,
  RerankRequest,
  RerankResult,
  ImageRequest,
  ImageResult,
  EndpointMapping,
  ConcurrencyStats,
} from './types.ts';

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };

class Queue<T> {
  private readonly items: T[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function diagnosticsOf(state: ConfigState): Diagnostic[] {
  const out: Diagnostic[] = [...state.globalDiagnostics];
  for (let index = 0; index < state.providers().length; index += 1) {
    const provider = state.providers()[index]!;
    if (provider.enabled === false) continue;
  }
  for (const view of state.views()) {
    for (const diagnostic of view.diagnostics) {
      if (!out.some((d) => d.path === diagnostic.path && d.message === diagnostic.message)) out.push(diagnostic);
    }
  }
  for (const family of state.raw.families ?? []) {
    const probe = (family.match ?? []).map((pattern) => pattern.replace(/^\^|\$$/g, '')).find((value) => value.length > 0) ?? family.id;
    try {
      const effective = state.resolve(probe, family.provider);
      for (const diagnostic of effective.diagnostics) {
        if (!out.some((d) => d.path === diagnostic.path && d.message === diagnostic.message)) out.push(diagnostic);
      }
    } catch {
      // resolution failure is reported by the probe itself through views/global diagnostics
    }
  }
  return out;
}

function applyEnv(env: Record<string, string | undefined> | undefined, reference: string): string | undefined {
  if (!env) return process.env[reference];
  return env[reference];
}

function aggregate(events: AsyncIterable<LLMEvent>, opts: { allowEmpty?: boolean } = {}): Promise<ChatResult> {
  return (async () => {
    let text = '';
    let textSignature: string | undefined;
    let thinking = '';
    let signature: string | undefined;
    let redacted: string | undefined;
    let encrypted: string | undefined;
    const thinkingBlocks: ThinkingBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let usage: Usage = { ...EMPTY_USAGE };
    let stopReason: ChatResult['stopReason'] = 'end_turn';
    for await (const event of events) {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          break;
        case 'text_end':
          if (event.signature !== undefined) textSignature = event.signature;
          break;
        case 'thinking_delta':
          thinking += event.text;
          break;
        case 'thinking_end':
          if (event.block) {
            thinkingBlocks.push(event.block);
          } else {
            thinking = event.text || thinking;
          }
          if (event.signature !== undefined) signature = event.signature;
          redacted = event.redacted ?? redacted;
          encrypted = event.encrypted ?? encrypted;
          break;
        case 'tool_call':
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            ...(event.async ? { async: true } : {}),
            ...(event.signature ? { signature: event.signature } : {}),
            ...(event.providerId ? { providerId: event.providerId } : {}),
          });
          break;
        case 'usage':
          usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite };
          break;
        case 'done':
          stopReason = event.stopReason;
          break;
        case 'error':
          throw event.error;
        default:
          break;
      }
    }
    const blockText = thinkingBlocks
      .filter((block): block is Extract<ThinkingBlock, { type: 'thinking' }> => block.type === 'thinking')
      .map((block) => block.text)
      .join('');
    const effectiveThinking = thinkingBlocks.length > 0 ? blockText : thinking;
    if (
      !opts.allowEmpty &&
      stopReason !== 'refusal' &&
      !text &&
      !textSignature &&
      !effectiveThinking &&
      thinkingBlocks.length === 0 &&
      !signature &&
      !redacted &&
      toolCalls.length === 0
    ) {
      throw new LLMError('EMPTY_RESPONSE', '模型返回了空响应');
    }
    return {
      text,
      ...(textSignature ? { textSignature } : {}),
      ...(effectiveThinking || thinkingBlocks.length > 0 || signature || redacted || encrypted
        ? {
            thinking: {
              text: effectiveThinking,
              ...(signature ? { signature } : {}),
              ...(redacted ? { redacted } : {}),
              ...(thinkingBlocks.length > 0 ? { blocks: thinkingBlocks } : {}),
              ...(encrypted ? { encrypted } : {}),
            },
          }
        : {}),
      toolCalls,
      usage,
      stopReason,
    };
  })();
}

function adapterFor(effective: EffectiveModel) {
  if (effective.interfaceType === 'anthropic-messages') return anthropicAdapter;
  if (effective.interfaceType === 'openai-chat-completions') return openaiChatAdapter;
  if (effective.interfaceType === 'openai-responses') return responsesAdapter;
  if (effective.interfaceType === 'gemini-generate-content') return geminiAdapter;
  throw new LLMError('UNSUPPORTED_FEATURE', `尚未实现 ${effective.interfaceType}`, {
    provider: effective.providerId,
    model: effective.id,
  });
}

export function createLLM(input: LLMConfig | unknown, opts: CreateOptions = {}): LLM {
  const parsed = parseConfig(input, opts);
  if (!parsed.config) {
    const message = parsed.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.path}: ${d.message}`).join('; ');
    throw new LLMError('INVALID_CONFIG', message || '配置不合法');
  }
  let config: LLMConfig = parsed.config;
  let state = new ConfigState(config, opts);
  const listeners = new Set<(change: ChangeEvent) => void>();
  const discovered = new Map<string, ModelCandidate[]>();
  const active = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();
  const stats = new Map<string, ConcurrencyStats>();

  function statsFor(provider: string): ConcurrencyStats {
    const current = stats.get(provider) ?? { active: 0, queued: 0, peak: 0 };
    stats.set(provider, current);
    return current;
  }

  async function acquire(provider: string, limit: number | undefined): Promise<void> {
    if (!limit || limit <= 0) return;
    const counters = statsFor(provider);
    while ((active.get(provider) ?? 0) >= limit) {
      counters.queued += 1;
      await new Promise<void>((resolve) => {
        const queue = waiting.get(provider) ?? [];
        queue.push(resolve);
        waiting.set(provider, queue);
      });
      counters.queued = Math.max(0, counters.queued - 1);
    }
    const next = (active.get(provider) ?? 0) + 1;
    active.set(provider, next);
    counters.active = next;
    counters.peak = Math.max(counters.peak, next);
  }

  function release(provider: string): void {
    const next = Math.max(0, (active.get(provider) ?? 1) - 1);
    active.set(provider, next);
    const counters = statsFor(provider);
    counters.active = next;
    waiting.get(provider)?.shift()?.();
  }

  function entryIdOf(path: string, candidate: LLMConfig): string | undefined {
    const match = /^(providers|families|models)\[([^\]]+)\]/.exec(path);
    if (!match) return undefined;
    const section = match[1] as 'providers' | 'families' | 'models';
    const key = match[2] ?? '';
    const list = (candidate[section] ?? []) as { id: string }[];
    const id = /^\d+$/.test(key) ? list[Number(key)]?.id : key;
    return id ? `${section}:${id}` : undefined;
  }

  function validateRequest(effective: EffectiveModel, request: ChatRequest): void {
    const hasImage = request.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
    );
    if (!effective.force && hasImage && effective.capabilities.modalities && !effective.capabilities.modalities.includes('image')) {
      throw new LLMError('UNSUPPORTED_FEATURE', `模型 ${effective.id} 未声明图片输入`, {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    if (effective.interfaceType !== 'openai-responses' && request.tools?.some((tool) => tool.async === true)) {
      throw new LLMError('UNSUPPORTED_FEATURE', '异步工具只在 openai-responses 上可用', {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    if (effective.interfaceType === 'gemini-generate-content' && (request.deferredTools?.length || request.tools?.some((tool) => tool.deferLoading))) {
      throw new LLMError('UNSUPPORTED_FEATURE', 'Gemini generateContent 不支持延迟加载工具', {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    const midSystem = request.messages.find((message) => message.role === 'system' && (message.toolChanges || message.outputConfig));
    if (midSystem && effective.interfaceType !== 'anthropic-messages') {
      throw new LLMError('UNSUPPORTED_FEATURE', '工具变更/逐消息 effort 只在 anthropic-messages 上可用', {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    if (midSystem && effective.interfaceType === 'anthropic-messages') {
      const declared = new Set((request.tools ?? []).map((tool) => tool.name));
      for (const message of request.messages) {
        if (message.role !== 'system' || !message.toolChanges) continue;
        for (const name of [...(message.toolChanges.add ?? []), ...(message.toolChanges.remove ?? [])]) {
          if (!declared.has(name)) {
            throw new LLMError('INVALID_REQUEST', `工具变更引用了未声明的工具 ${name}`, {
              provider: effective.providerId,
              model: effective.id,
            });
          }
        }
      }
    }
    if (request.configurationUpdates?.length && effective.interfaceType !== 'openai-responses') {
      throw new LLMError('UNSUPPORTED_FEATURE', 'configurationUpdates 只在 openai-responses 上可用', {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    if (request.serverWebSearch === true && effective.interfaceType === 'gemini-generate-content') {
      throw new LLMError('UNSUPPORTED_FEATURE', 'Gemini 原生线暂未映射 serverWebSearch（built-in tools）', {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    const hasCacheBreakpoint = request.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'text' && part.promptCacheBreakpoint),
    );
    if (hasCacheBreakpoint && effective.interfaceType !== 'openai-responses') {
      throw new LLMError('UNSUPPORTED_FEATURE', 'promptCacheBreakpoint 只在 openai-responses 上可用', {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    if (request.promptCacheKey !== undefined) {
      if (effective.interfaceType !== 'openai-responses') {
        throw new LLMError('UNSUPPORTED_FEATURE', 'promptCacheKey 只在 openai-responses 上可用', {
          provider: effective.providerId,
          model: effective.id,
        });
      }
      if (typeof request.promptCacheKey !== 'string') {
        throw new LLMError('INVALID_REQUEST', 'promptCacheKey 必须是字符串', {
          provider: effective.providerId,
          model: effective.id,
        });
      }
    }
    if (request.promptCacheOptions) {
      if (effective.interfaceType !== 'openai-responses') {
        throw new LLMError('UNSUPPORTED_FEATURE', 'promptCacheOptions 只在 openai-responses 上可用', {
          provider: effective.providerId,
          model: effective.id,
        });
      }
      const { mode, ttl } = request.promptCacheOptions;
      if (mode !== undefined && mode !== 'implicit' && mode !== 'explicit') {
        throw new LLMError('INVALID_REQUEST', `promptCacheOptions.mode 不支持 ${String(mode)}`, {
          provider: effective.providerId,
          model: effective.id,
        });
      }
      if (ttl !== undefined && ttl !== '30m' && ttl !== '12h') {
        throw new LLMError('INVALID_REQUEST', `promptCacheOptions.ttl 不支持 ${String(ttl)}`, {
          provider: effective.providerId,
          model: effective.id,
        });
      }
    }
    if (!effective.force && request.thinking && effective.capabilities.thinking && !effective.capabilities.thinking.includes(request.thinking)) {
      throw new LLMError('INVALID_REQUEST', `模型 ${effective.id} 不支持思考模式 ${request.thinking}`, {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    if (request.cacheBreakpoints?.length) {
      if (effective.interfaceType !== 'anthropic-messages') {
        throw new LLMError('UNSUPPORTED_FEATURE', 'cacheBreakpoints 只在 anthropic-messages 上可用', {
          provider: effective.providerId,
          model: effective.id,
        });
      }
      if (effective.caching !== 'explicit') {
        throw new LLMError('UNSUPPORTED_FEATURE', 'cacheBreakpoints 需要 caching: explicit', {
          provider: effective.providerId,
          model: effective.id,
        });
      }
    }
  }

  function discoveredViews(): ModelView[] {
    const out: ModelView[] = [];
    for (const [providerId, candidates] of discovered) {
      const provider = state.providers().find((item) => item.id === providerId);
      if (!provider) continue;
      for (const candidate of candidates) {
        out.push({
          id: candidate.id,
          provider: providerId,
          force: state.raw.force ?? false,
          upstream: candidate.id,
          interfaceType: provider.interfaceType,
          contextWindow: candidate.contextWindow ?? 256_000,
          maxOutput: candidate.maxOutput ?? 65_536,
          capabilities: {},
          defaults: {},
          caching: state.raw.defaults?.caching ?? 'auto',
          enabled: provider.enabled !== false,
          source: 'discovered',
          state: 'ok',
          diagnostics: [],
        });
      }
    }
    return out;
  }

  function effectiveFor(model: string, provider?: string): EffectiveModel {
    const effective = state.resolve(model, provider);
    if (effective.state === 'error') {
      throw new LLMError('INVALID_CONFIG', effective.diagnostics.map((d) => `${d.path}: ${d.message}`).join('; '), {
        provider: effective.providerId,
        model: effective.id,
      });
    }
    return effective;
  }

  async function endpointCall(
    effective: EffectiveModel,
    mapping: EndpointMapping | undefined,
    defaultPath: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ json: unknown }> {
    const apiKey = resolveApiKey(effective, opts.env);
    const headers = buildHeaders(effective, apiKey);
    const url = joinUrl(effective.baseUrl, mapping?.path ?? effective.path ?? defaultPath, defaultPath, effective.query);
    const spec = {
      url,
      method: 'POST',
      headers,
      body,
      streamIdleTimeoutMs: effective.streamIdleTimeoutMs,
      connectTimeoutMs: effective.connectTimeoutMs,
      retry: effective.retry,
      provider: effective.providerId,
      model: effective.id,
      errors: effective.errors,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(signal ? { signal } : {}),
    };
    const { json } = await requestJson(spec);
    return { json };
  }

  function usageOf(json: unknown): Usage {
    const root = obj(json);
    const usage = obj(root?.usage) ?? {};
    return {
      inputTokens: num(usage.input_tokens) ?? num(usage.prompt_tokens) ?? 0,
      outputTokens: num(usage.output_tokens) ?? num(usage.completion_tokens) ?? 0,
      cacheRead: num(usage.cache_read_input_tokens) ?? num(obj(usage.prompt_tokens_details)?.cached_tokens) ?? 0,
      cacheWrite: num(usage.cache_creation_input_tokens) ?? 0,
    };
  }

  function changed(previous: LLMConfig, next: LLMConfig): string[] {
    const out: string[] = [];
    const byId = (list: { id: string }[] | undefined) =>
      new Map((list ?? []).map((item) => [item.id, JSON.stringify(item)]));
    for (const section of ['providers', 'families', 'models'] as const) {
      const before = byId(previous[section] as { id: string }[] | undefined);
      const after = byId(next[section] as { id: string }[] | undefined);
      for (const id of after.keys()) if (!before.has(id)) out.push(`${section}:${id}:add`);
      for (const id of before.keys()) if (!after.has(id)) out.push(`${section}:${id}:remove`);
      for (const [id, json] of after) if (before.get(id) !== undefined && before.get(id) !== json) out.push(`${section}:${id}:update`);
    }
    return out;
  }

  function eventsFor(request: ChatRequest, streamOpts: ChatStreamOptions, stream: boolean): AsyncIterable<LLMEvent> {
      const queue = new Queue<LLMEvent>();
      const snapshot = state;
      const signal = request.signal && streamOpts.signal
        ? AbortSignal.any([request.signal, streamOpts.signal])
        : (streamOpts.signal ?? request.signal);
      void (async () => {
        try {
          const effective = snapshot.resolve(request.model, request.provider);
          if (effective.state === 'error') {
            throw new LLMError('INVALID_CONFIG', effective.diagnostics.map((d) => `${d.path}: ${d.message}`).join('; '), {
              provider: effective.providerId,
              model: effective.id,
            });
          }
          validateRequest(effective, request);
          const adapter = adapterFor(effective);
          const limit = effective.provider.maxConcurrent;
          await acquire(effective.providerId, limit);
          try {
            await adapter.run(
            {
              effective,
              request,
              stream,
              env: opts.env,
              ...(opts.fetch ? { fetch: opts.fetch } : {}),
              ...(signal ? { signal } : {}),
              ...(streamOpts.onRawEvent ? { onRawEvent: streamOpts.onRawEvent } : {}),
            },
              (event) => queue.push(event),
            );
          } finally {
            release(effective.providerId);
          }
        } catch (cause) {
          queue.push({ type: 'error', error: cause instanceof LLMError ? cause : new LLMError('TRANSPORT', (cause as Error).message, { cause }) });
        } finally {
          queue.end();
        }
      })();
      return queue;
  }

  const llm: LLM = {
    async chat(request: ChatRequest): Promise<ChatResult> {
      return aggregate(eventsFor(request, {}, false), { allowEmpty: request.promptCacheOptions?.prewarm === true });
    },

    chatStream(request: ChatRequest, streamOpts: ChatStreamOptions = {}): AsyncIterable<LLMEvent> {
      return eventsFor(request, streamOpts, true);
    },

    models(): ModelView[] {
      return [...state.views(), ...discoveredViews()];
    },

    model(id: string, provider?: string): ModelView | undefined {
      const declared = (state.raw.models ?? []).some((item) => item.id === id || (item.aliases ?? []).includes(id));
      const found = discoveredViews().find((view) => view.id === id && (!provider || view.provider === provider));
      if (found && !declared) return found;
      return state.modelView(id, provider) ?? found;
    },

    providers(): ProviderView[] {
      return state.providerViews();
    },

    describe(): unknown {
      return state.describe();
    },

    validate(next?: unknown): Diagnostic[] {
      const candidate = next === undefined ? config : next;
      const parsedConfig = parseConfig(candidate, opts);
      const diagnostics: Diagnostic[] = [...parsedConfig.diagnostics];
      if (!parsedConfig.config) return diagnostics;
      const candidateState = new ConfigState(parsedConfig.config, opts);
      for (const diagnostic of diagnosticsOf(candidateState)) {
        if (!diagnostics.some((d) => d.path === diagnostic.path && d.message === diagnostic.message)) diagnostics.push(diagnostic);
      }
      return diagnostics;
    },

    apply(next: unknown): ApplyResult {
      const parsedConfig = parseConfig(next, opts);
      const diagnostics: Diagnostic[] = [...parsedConfig.diagnostics];
      if (!parsedConfig.config) return { ok: false, changed: [], diagnostics };
      const candidate = parsedConfig.config;
      const candidateState = new ConfigState(candidate, opts);
      for (const diagnostic of diagnosticsOf(candidateState)) {
        if (!diagnostics.some((d) => d.path === diagnostic.path && d.message === diagnostic.message)) diagnostics.push(diagnostic);
      }
      const delta = changed(config, candidate);
      const changedEntries = new Set(delta.filter((item) => !item.endsWith(':remove')).map((item) => item.slice(0, item.lastIndexOf(':'))));
      const blocking = diagnostics.filter((diagnostic) => {
        if (diagnostic.severity !== 'error') return false;
        const key = entryIdOf(diagnostic.path, candidate);
        return key === undefined || changedEntries.has(key);
      });
      if (blocking.length > 0) return { ok: false, changed: [], diagnostics };
      config = parsedConfig.config;
      state = candidateState;
      const event: ChangeEvent = { providers: [], families: [], models: [] };
      for (const item of delta) {
        const [section] = item.split(':') as ['providers' | 'families' | 'models'];
        event[section].push(item);
      }
      for (const listener of listeners) listener(event);
      return { ok: true, changed: delta, diagnostics };
    },

    async save(): Promise<void> {
      if (!opts.source) throw new LLMError('INVALID_CONFIG', '没有配置来源路径，无法 save()');
      saveConfigFile(opts.source, config);
    },

    onConfigChange(fn: (change: ChangeEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async discover(providerId: string): Promise<ModelCandidate[]> {
      const provider = state.providers().find((p) => p.id === providerId);
      if (!provider) throw new LLMError('INVALID_CONFIG', `provider 不存在：${providerId}`);
      const effective = state.resolve(
        (state.raw.models ?? []).find((m) => m.provider === providerId)?.id ?? `${providerId}/discover`,
        providerId,
      );
      const apiKey = resolveApiKey(effective, opts.env);
      const headers = buildHeaders(effective, apiKey);
      const path = provider.discover?.path ?? '/models';
      const url = joinUrl(effective.baseUrl, path, '/models', provider.query);
      const spec = {
        url,
        method: 'GET',
        headers,
        streamIdleTimeoutMs: effective.streamIdleTimeoutMs,
        connectTimeoutMs: effective.connectTimeoutMs,
        retry: effective.retry,
        provider: providerId,
        model: effective.id,
        errors: effective.errors,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      };
      const { json, text } = await requestJson(spec);
      void text;
      return readCandidates(json, provider.discover?.readPath, {
        stripModelsPrefix: provider.interfaceType === 'gemini-generate-content',
      });
    },

    async refresh(providerId: string): Promise<ModelCandidate[]> {
      const candidates = await llm.discover(providerId);
      discovered.set(providerId, candidates);
      return candidates;
    },

    async embed(request: EmbedRequest): Promise<EmbedResult> {
      const effective = effectiveFor(request.model, request.provider);
      const body: Record<string, unknown> = { model: effective.upstream, input: request.input };
      if (request.dimensions !== undefined) body.dimensions = request.dimensions;
      Object.assign(body, request.extra ?? {});
      const mapping = effective.provider.embed;
      const { json } = await endpointCall(effective, mapping, '/embeddings', body, request.signal);
      const vectors = selectPath(json, mapping?.readPath ?? '$.data[*].embedding') as number[][];
      return { vectors, usage: usageOf(json) };
    },

    async rerank(request: RerankRequest): Promise<RerankResult> {
      const effective = effectiveFor(request.model, request.provider);
      const body: Record<string, unknown> = {
        model: effective.upstream,
        query: request.query,
        documents: request.documents,
      };
      if (request.topN !== undefined) body.top_n = request.topN;
      Object.assign(body, request.extra ?? {});
      const mapping = effective.provider.rerank;
      const { json } = await endpointCall(effective, mapping, '/rerank', body, request.signal);
      const items = selectArray(json, mapping?.readPath ?? '$.results') as Record<string, unknown>[];
      const results = items.map((item, index) => {
        const entry = obj(item) ?? {};
        return {
          index: num(entry.index) ?? index,
          score: num(entry.relevance_score) ?? num(entry.score) ?? 0,
          ...(str(entry.document) ? { document: str(entry.document) } : {}),
        };
      });
      return { results, usage: usageOf(json) };
    },

    async image(request: ImageRequest): Promise<ImageResult> {
      const effective = effectiveFor(request.model, request.provider);
      const body: Record<string, unknown> = { model: effective.upstream, prompt: request.prompt };
      if (request.size !== undefined) body.size = request.size;
      if (request.n !== undefined) body.n = request.n;
      Object.assign(body, request.extra ?? {});
      const mapping = effective.provider.image;
      const { json } = await endpointCall(effective, mapping, '/images/generations', body, request.signal);
      const items = selectArray(json, mapping?.readPath ?? '$.data[*]') as Record<string, unknown>[];
      const images = items.map((item) => {
        const entry = obj(item) ?? {};
        return {
          ...(str(entry.url) ? { url: str(entry.url) } : {}),
          ...(str(entry.b64_json) ? { b64: str(entry.b64_json) } : {}),
          ...(str(entry.media_type) ? { mediaType: str(entry.media_type) } : {}),
        };
      });
      return { images, usage: usageOf(json) };
    },

    concurrency(): Record<string, ConcurrencyStats> {
      const out: Record<string, ConcurrencyStats> = {};
      for (const provider of state.providers()) {
        const current = statsFor(provider.id);
        out[provider.id] = { active: current.active, queued: current.queued, peak: current.peak };
      }
      return out;
    },

    schema: configJsonSchema(),
  };

  return llm;
}

function readCandidates(
  json: unknown,
  readPath?: string,
  options: { stripModelsPrefix?: boolean } = {},
): ModelCandidate[] {
  const root = obj(json);
  if (!root) return [];
  let items: unknown[] = [];
  if (readPath) {
    const path = readPath.replace(/^\$\.?/, '');
    const [arrayPath] = path.split('[*]');
    let cursor: unknown = root;
    for (const segment of (arrayPath ?? '').split('.').filter(Boolean)) {
      cursor = obj(cursor)?.[segment];
    }
    items = Array.isArray(cursor) ? cursor : [];
  } else if (Array.isArray(root.data)) {
    items = root.data;
  } else if (Array.isArray(root.models)) {
    items = root.models;
  } else if (root.models && typeof root.models === 'object') {
    items = Object.entries(root.models as Record<string, unknown>).map(([id, value]) => ({ id, ...(obj(value) ?? {}) }));
  }
  const out: ModelCandidate[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      out.push({ id: item });
      continue;
    }
    const entry = obj(item);
    if (!entry) continue;
    const rawId = str(entry.id) ?? str(entry.model) ?? str(entry.name);
    if (!rawId) continue;
    const id = options.stripModelsPrefix ? rawId.replace(/^models\//, '') : rawId;
    const contextWindow =
      num(entry.context_window) ?? num(entry.contextWindow) ?? num(entry.max_input_tokens) ?? num(entry.maxInputTokens) ??
      num(entry.inputTokenLimit);
    const maxOutput =
      num(entry.max_tokens) ?? num(entry.maxOutput) ?? num(entry.output_token_limit) ?? num(entry.outputTokenLimit);
    const displayName = str(entry.display_name) ?? str(entry.displayName) ?? str(entry.name);
    out.push({
      id,
      ...(displayName ? { name: displayName } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
    });
  }
  return out;
}

export { loadConfig, configJsonSchema, saveConfigFile, parseConfig };
export { LLMError, isLLMError } from './errors.ts';
export type { ErrorCode } from './errors.ts';
export type * from './types.ts';
export type { EffectiveModel } from './config.ts';
export { ConfigState } from './config.ts';
export type { ProviderConfig, ProviderView, ModelView, Diagnostic, ApplyResult, ChangeEvent };
