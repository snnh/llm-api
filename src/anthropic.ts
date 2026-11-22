import { LLMError } from './errors.ts';
import {
  EMPTY_USAGE,
  joinUrl,
  mapStopReason,
  num,
  obj,
  str,
  type Adapter,
  type AdapterContext,
  type Emit,
} from './adapter.ts';
import { applyThinking, buildHeaders, maxTokensValue, mergeBody, resolveApiKey } from './params.ts';
import { classifyStatus, openStream, readSse, requestJson, type RawEvent } from './transport.ts';
import type { ChatRequest, ContentPart, Message, ThinkingBlock, Usage } from './types.ts';

const MAX_CACHE_BREAKPOINTS = 4;

function contentBlocks(content: string | ContentPart[] | undefined): Record<string, unknown>[] | undefined {
  if (content === undefined) return undefined;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } },
  );
}

function withCacheControl(blocks: Record<string, unknown>[] | undefined): Record<string, unknown>[] | undefined {
  if (!blocks?.length) return blocks;
  const copy = blocks.map((block) => ({ ...block }));
  const last = copy[copy.length - 1]!;
  last.cache_control = { type: 'ephemeral' };
  return copy;
}

function convertMessages(effective: AdapterContext['effective'], request: ChatRequest, explicitCaching: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const ids: (string | undefined)[] = [];
  let system = request.system;
  for (const message of request.messages) {
    if (message.role === 'user') {
      let blocks = contentBlocks(message.content);
      if (system && out.length === 0 && effective.compat.systemPrompt === 'message') {
        blocks = [{ type: 'text', text: system }, ...(blocks ?? [])];
        system = undefined;
      }
      out.push({ role: 'user', content: blocks, ...effective.messageFields });
      ids.push(message.id);
    } else if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (message.reasoning?.blocks?.length) {
        for (const block of message.reasoning.blocks) {
          if (block.type === 'thinking') {
            blocks.push({ type: 'thinking', thinking: block.text, ...(block.signature ? { signature: block.signature } : {}) });
          } else {
            blocks.push({ type: 'redacted_thinking', data: block.data });
          }
        }
      } else if (message.reasoning && (message.reasoning.text || message.reasoning.signature)) {
        blocks.push({
          type: 'thinking',
          thinking: message.reasoning.text,
          ...(message.reasoning.signature ? { signature: message.reasoning.signature } : {}),
        });
      }
      if (!message.reasoning?.blocks?.length && message.reasoning?.redacted) {
        blocks.push({ type: 'redacted_thinking', data: message.reasoning.redacted });
      }
      const text = contentBlocks(message.content);
      if (text) blocks.push(...text);
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      out.push({ role: 'assistant', content: blocks, ...effective.messageFields });
      ids.push(message.id);
    } else if (message.role === 'system') {
      const blocks = contentBlocks(message.content) ?? [];
      for (const block of blocks) {
        if (block.type !== 'text') {
          throw new LLMError('UNSUPPORTED_FEATURE', 'system 消息只支持文本与工具变更块', {
            provider: effective.providerId,
            model: effective.id,
          });
        }
      }
      for (const name of message.toolChanges?.remove ?? []) {
        blocks.push({ type: 'tool_removal', tool: { type: 'tool_reference', name } });
      }
      for (const name of message.toolChanges?.add ?? []) {
        blocks.push({ type: 'tool_addition', tool: { type: 'tool_reference', name } });
      }
      if (blocks.length === 0 && !message.outputConfig?.effort) continue;
      out.push({
        role: 'system',
        content: blocks,
        ...(message.outputConfig?.effort ? { output_config: { effort: message.outputConfig.effort } } : {}),
        ...effective.messageFields,
      });
      ids.push(message.id);
    } else {
      const blocks = contentBlocks(message.content) ?? [{ type: 'text', text: '' }];
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: blocks,
            ...(message.isError === true ? { is_error: true } : {}),
          },
        ],
        ...effective.messageFields,
      });
      ids.push(message.id);
    }
  }
  const breakpoints = new Set(request.cacheBreakpoints ?? []);
  if (explicitCaching) {
    const marked = ids.map((id, index) => ({ id, index })).filter(({ id }) => id !== undefined && breakpoints.has(id));
    const target = marked.length ? marked[marked.length - 1]!.index : out.length - 1;
    const last = out[target];
    if (last) last.content = withCacheControl(last.content as Record<string, unknown>[]);
  }
  return out;
}

function buildTools(effective: AdapterContext['effective'], request: ChatRequest, explicitCaching: boolean): Record<string, unknown>[] | undefined {
  if (!request.tools?.length) return undefined;
  if (!effective.force && effective.capabilities.tools === false) {
    throw new LLMError('INVALID_REQUEST', `模型 ${effective.id} 未声明 tools 能力`, {
      provider: effective.providerId,
      model: effective.id,
    });
  }
  const deferred = new Set(request.deferredTools ?? []);
  if (!effective.force && deferred.size > 0 && !effective.capabilities.deferLoading) {
    throw new LLMError('INVALID_REQUEST', `模型 ${effective.id} 未声明 deferLoading，不能推迟加载工具`, {
      provider: effective.providerId,
      model: effective.id,
    });
  }
  const tools: Record<string, unknown>[] = request.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
    ...effective.toolFields,
    ...(deferred.has(tool.name) || tool.deferLoading ? { defer_loading: true } : {}),
  }));
  if (explicitCaching) {
    const last = tools[tools.length - 1];
    if (last) last.cache_control = { type: 'ephemeral' };
  }
  return tools;
}

function buildSystem(effective: AdapterContext['effective'], request: ChatRequest, explicitCaching: boolean): unknown {
  if (!request.system || effective.compat.systemPrompt === 'message') return undefined;
  if (!explicitCaching) return request.system;
  return [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }];
}

function buildBody(ctx: AdapterContext): Record<string, unknown> {
  const { effective, request, stream } = ctx;
  const explicitCaching = effective.caching === 'explicit';
  const maxTokens = maxTokensValue(effective, request) ?? effective.maxOutput;
  const core: Record<string, unknown> = {
    model: effective.upstream,
    messages: convertMessages(effective, request, explicitCaching),
    max_tokens: effective.compat.maxTokensField
      ? (request.maxTokens ?? effective.defaults.maxTokens ?? effective.maxOutput)
      : maxTokens,
  };
  if (effective.compat.maxTokensField) {
    core[effective.compat.maxTokensField] = core.max_tokens;
    delete core.max_tokens;
  }
  const system = buildSystem(effective, request, explicitCaching);
  if (system !== undefined) core.system = system;
  const tools = buildTools(effective, request, explicitCaching);
  if (tools) core.tools = tools;
  Object.assign(core, applyThinking(effective, request, 'anthropic-messages').anthropic ?? {});
  if (request.effort && (
    effective.capabilities.thinkingStyle === 'adaptive' ||
    effective.capabilities.thinkingStyle === 'extended' ||
    effective.capabilities.thinkingStyle === 'fixed' ||
    effective.capabilities.outputConfigEffort === true
  )) {
    core.output_config = { effort: request.effort };
  }
  if (stream) core.stream = true;
  return mergeBody(effective, request, core);
}

function usageFrom(value: unknown, base: Usage): Usage {
  const usage = obj(value);
  if (!usage) return base;
  return {
    inputTokens: num(usage.input_tokens) ?? base.inputTokens,
    outputTokens: num(usage.output_tokens) ?? base.outputTokens,
    cacheRead: num(usage.cache_read_input_tokens) ?? base.cacheRead,
    cacheWrite: num(usage.cache_creation_input_tokens) ?? base.cacheWrite,
  };
}

interface BlockState {
  type: string;
  text: string;
  signature?: string;
  redacted?: string;
  id?: string;
  name?: string;
  args: string;
}

function parseBlock(index: number, data: unknown, emit: Emit, blocks: Map<number, BlockState>, state: { usage: Usage; stopReason?: string; sawStreamEnd?: boolean }) {
  const json = obj(data);
  const type = str(json?.type);
  if (type === 'message_start') {
    state.usage = usageFrom(obj(json?.message)?.usage, state.usage);
    return;
  }
  if (type === 'content_block_start') {
    const block = obj(json?.content_block);
    const kind = str(block?.type) ?? 'text';
    const entry: BlockState = { type: kind, text: '', args: '' };
    if (kind === 'tool_use') {
      entry.id = str(block?.id);
      entry.name = str(block?.name);
    } else if (kind === 'redacted_thinking') {
      entry.redacted = str(block?.data);
    }
    blocks.set(num(json?.index) ?? 0, entry);
    return;
  }
  if (type === 'content_block_delta') {
    const index = num(json?.index) ?? 0;
    const delta = obj(json?.delta);
    const draft = str(delta?.text);
    const thinking = str(delta?.thinking);
    const signature = str(delta?.signature);
    const partial = str(delta?.partial_json);
    const entry = blocks.get(index);
    if (draft !== undefined) {
      if (entry) entry.text += draft;
      emit({ type: 'text_delta', text: draft });
    } else if (thinking !== undefined) {
      if (entry) entry.text += thinking;
      emit({ type: 'thinking_delta', text: thinking });
    } else if (signature !== undefined) {
      if (entry) entry.signature = signature;
    } else if (partial !== undefined) {
      if (entry) entry.args += partial;
      emit({ type: 'tool_call_delta', id: entry?.id ?? `tool_${index}`, ...(entry?.name ? { name: entry.name } : {}), argumentsDelta: partial });
    }
    void delta;
    return;
  }
  if (type === 'content_block_stop') {
    const entry = blocks.get(num(json?.index) ?? 0);
    if (!entry) return;
    if (entry.type === 'text') emit({ type: 'text_end', text: entry.text });
    else if (entry.type === 'thinking') {
      const block: ThinkingBlock = { type: 'thinking', text: entry.text, ...(entry.signature ? { signature: entry.signature } : {}) };
      emit({ type: 'thinking_end', text: entry.text, ...(entry.signature ? { signature: entry.signature } : {}), block });
    } else if (entry.type === 'redacted_thinking') {
      const block: ThinkingBlock = { type: 'redacted_thinking', data: entry.redacted ?? '' };
      emit({ type: 'thinking_end', text: '', ...(entry.redacted ? { redacted: entry.redacted } : {}), block });
    } else if (entry.type === 'tool_use') {
      let input: Record<string, unknown> = {};
      if (entry.args.trim()) {
        try {
          input = obj(JSON.parse(entry.args)) ?? {};
        } catch {
          throw new LLMError('INVALID_REQUEST', `工具 ${entry.name} 的参数不是合法 JSON`);
        }
      }
      emit({ type: 'tool_call', id: entry.id ?? 'tool_0', name: entry.name ?? '', input });
    }
    return;
  }
  if (type === 'message_delta') {
    const stop = str(obj(json?.delta)?.stop_reason);
    if (stop) state.stopReason = stop;
    state.usage = usageFrom(json?.usage, state.usage);
    return;
  }
  if (type === 'message_stop') {
    state.sawStreamEnd = true;
    return;
  }
  if (type === 'error') {
    const error = obj(json?.error);
    throw new LLMError('TRANSPORT', str(error?.message) ?? '上游返回 error 事件');
  }
}

async function emitNonStream(ctx: AdapterContext, emit: Emit, json: unknown) {
  const root = obj(json);
  if (!root) throw new LLMError('TRANSPORT', '响应不是对象', { provider: ctx.effective.providerId, model: ctx.effective.id });
  const content = Array.isArray(root.content) ? root.content : [];
  for (const raw of content) {
    const block = obj(raw);
    const type = str(block?.type);
    if (type === 'text') {
      const text = str(block?.text) ?? '';
      if (text) {
        emit({ type: 'text_delta', text });
        emit({ type: 'text_end', text });
      }
    } else if (type === 'thinking') {
      const text = str(block?.thinking) ?? '';
      const signature = str(block?.signature);
      const thinkingBlock: ThinkingBlock = { type: 'thinking', text, ...(signature ? { signature } : {}) };
      emit({ type: 'thinking_delta', text });
      emit({ type: 'thinking_end', text, ...(signature ? { signature } : {}), block: thinkingBlock });
    } else if (type === 'redacted_thinking') {
      const redacted = str(block?.data);
      if (redacted) {
        const thinkingBlock: ThinkingBlock = { type: 'redacted_thinking', data: redacted };
        emit({ type: 'thinking_end', text: '', redacted, block: thinkingBlock });
      }
    } else if (type === 'tool_use') {
      emit({
        type: 'tool_call',
        id: str(block?.id) ?? 'tool_0',
        name: str(block?.name) ?? '',
        input: obj(block?.input) ?? {},
      });
    }
  }
  emit({ type: 'usage', ...usageFrom(root.usage, EMPTY_USAGE) });
  emit({ type: 'done', stopReason: mapStopReason(str(root.stop_reason)) });
}

function textOf(root: Record<string, unknown>): string {
  const content = Array.isArray(root.content) ? root.content : [];
  return content
    .map((raw) => (str(obj(raw)?.type) === 'text' ? str(obj(raw)?.text) ?? '' : ''))
    .join('');
}

function midConversationBetas(request: ChatRequest): string[] {
  let tools = false;
  let effort = false;
  for (const message of request.messages) {
    if (message.role !== 'system') continue;
    if ((message.toolChanges?.add?.length ?? 0) > 0 || (message.toolChanges?.remove?.length ?? 0) > 0) tools = true;
    if (message.outputConfig?.effort) effort = true;
  }
  return [
    ...(tools ? ['mid-conversation-tool-changes-2026-07-01'] : []),
    ...(effort ? ['mid-conversation-output-config-2026-07-01'] : []),
  ];
}

function addBetas(headers: Record<string, string>, betas: string[]): void {
  if (betas.length === 0) return;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'anthropic-beta') ?? 'anthropic-beta';
  const existing = headers[key]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  headers[key] = [...new Set([...existing, ...betas])].join(',');
}

export const anthropicAdapter: Adapter = {
  async run(ctx: AdapterContext, emit: Emit): Promise<void> {
    const { effective, stream } = ctx;
    const apiKey = resolveApiKey(effective, ctx.env);
    const headers = buildHeaders(effective, apiKey, ctx.request.headers);
    addBetas(headers, midConversationBetas(ctx.request));
    const url = joinUrl(effective.baseUrl, effective.path, '/messages', effective.query);
    const body = ctx.request.rawBody
      ? { ...ctx.request.rawBody, ...(stream ? { stream: true } : {}) }
      : buildBody(ctx);
    const spec = {
      url,
      headers,
      body,
      streamIdleTimeoutMs: effective.streamIdleTimeoutMs,
      connectTimeoutMs: effective.connectTimeoutMs,
      retry: effective.retry,
      provider: effective.providerId,
      model: effective.id,
      errors: effective.errors,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };

    if (!stream) {
      const { json, text } = await requestJson(spec);
      ctx.onRawEvent?.(text);
      const root = obj(json);
      if (root && !textOf(root) && !(Array.isArray(root.content) && root.content.length > 0)) {
        throw new LLMError('EMPTY_RESPONSE', '响应没有任何内容', { provider: effective.providerId, model: effective.id });
      }
      await emitNonStream(ctx, emit, json);
      return;
    }

    const handle = await openStream(spec);
    const contentType = handle.response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const text = await handle.response.text().catch(() => '');
      handle.close();
      ctx.onRawEvent?.(text);
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw classifyStatus(handle.response.status, text, { ...spec });
      }
      await emitNonStream(ctx, emit, json);
      return;
    }

    const blocks = new Map<number, BlockState>();
    const state = { usage: { ...EMPTY_USAGE }, stopReason: undefined as string | undefined, sawStreamEnd: false };
    const onEvent = (event: RawEvent): void => {
      ctx.onRawEvent?.(event.data);
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      const type = str(obj(data)?.type) ?? event.event;
      if (type) parseBlock(0, { ...(obj(data) ?? {}), type }, emit, blocks, state);
    };
    await readSse(handle, { ...spec }, onEvent);
    emit({ type: 'usage', ...state.usage });
    emit({
      type: 'done',
      stopReason: state.stopReason
        ? mapStopReason(state.stopReason)
        : state.sawStreamEnd ? 'end_turn' : 'error',
    });
  },
};
