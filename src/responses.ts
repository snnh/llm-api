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
import type { ChatRequest, ContentPart, Message } from './types.ts';

function inputContent(content: string | ContentPart[], role: 'user' | 'assistant' | 'system'): Record<string, unknown>[] {
  if (typeof content === 'string') {
    return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
  }
  return content.map((part) =>
    part.type === 'text'
      ? {
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: part.text,
          ...(role !== 'assistant' && part.promptCacheBreakpoint
            ? {
                prompt_cache_breakpoint: {
                  mode: part.promptCacheBreakpoint.mode,
                  ...(part.promptCacheBreakpoint.ttl ? { ttl: part.promptCacheBreakpoint.ttl } : {}),
                },
              }
            : {}),
        }
      : { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` },
  );
}

function reasoningTextOf(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const summaryText = summary.map((part) => str(obj(part)?.text) ?? '').join('');
  if (summaryText) return summaryText;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => str(obj(part)?.text) ?? '').join('');
}

function convertInput(effective: AdapterContext['effective'], request: ChatRequest): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (request.system && effective.compat.systemPrompt === 'message') {
    items.push({ role: 'user', content: [{ type: 'input_text', text: request.system }] });
  }
  for (const message of request.messages) {
    if (message.role === 'user') {
      items.push({ role: 'user', content: inputContent(message.content, 'user') });
    } else if (message.role === 'assistant') {
      if (message.content !== undefined) items.push({ role: 'assistant', content: inputContent(message.content, 'assistant') });
      if (message.reasoning?.encrypted) {
        items.push({
          type: 'reasoning',
          ...(message.reasoning.signature ? { id: message.reasoning.signature } : {}),
          encrypted_content: message.reasoning.encrypted,
        });
      } else if (message.reasoning?.text && effective.capabilities.reasoningContent) {
        items.push({
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: message.reasoning.text }],
        });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          ...(call.itemId ? { id: call.itemId } : {}),
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
          ...(call.async ? { async: true } : {}),
        });
      }
    } else if (message.role === 'system') {
      if (message.toolChanges || message.outputConfig) {
        throw new LLMError('UNSUPPORTED_FEATURE', '工具变更/逐消息 effort 只在 anthropic-messages 上可用', {
          provider: effective.providerId,
          model: effective.id,
        });
      }
      items.push({ role: 'system', content: inputContent(message.content ?? '', 'system') });
    } else {
      items.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: typeof message.content === 'string' ? message.content : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
      });
    }
  }
  if (request.configurationUpdates?.length) {
    const updates = request.configurationUpdates.map((update) => ({
      type: 'configuration_update',
      ...(update.reasoning ? { reasoning: update.reasoning } : {}),
      ...(update.text ? { text: update.text } : {}),
    }));
    const index = items.findLastIndex((item) => item.role === 'user');
    items.splice(index < 0 ? items.length : index, 0, ...updates);
  }
  return items;
}

function convertTools(effective: AdapterContext['effective'], request: ChatRequest): Record<string, unknown>[] | undefined {
  if (!request.tools?.length) return undefined;
  if (!effective.force && effective.capabilities.tools === false) {
    throw new LLMError('INVALID_REQUEST', `模型 ${effective.id} 未声明 tools 能力`, { provider: effective.providerId, model: effective.id });
  }
  return request.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
    ...(tool.async === true ? { async: true } : {}),
    ...effective.toolFields,
  }));
}

function buildBody(ctx: AdapterContext): Record<string, unknown> {
  const { effective, request, stream } = ctx;
  const core: Record<string, unknown> = {
    model: effective.upstream,
    input: convertInput(effective, request),
  };
  if (request.system && effective.compat.systemPrompt !== 'message') core.instructions = request.system;
  if (stream) core.stream = true;
  const maxTokens = maxTokensValue(effective, request);
  if (maxTokens !== undefined) {
    const field = effective.compat.maxTokensField ?? effective.fieldMap.maxTokens ?? 'max_output_tokens';
    core[field] = maxTokens;
  }
  const tools = convertTools(effective, request);
  if (tools) core.tools = tools;
  if (effective.capabilities.responsesEncryptedReplay) core.include = ['reasoning.encrypted_content'];
  if (request.effort && effective.capabilities.thinkingStyle) core.reasoning = { effort: request.effort };
  if (request.jsonMode === true) core.text = { format: { type: 'json_object' } };
  if (request.promptCacheOptions) {
    const options: Record<string, unknown> = {};
    if (request.promptCacheOptions.mode) options.mode = request.promptCacheOptions.mode;
    if (request.promptCacheOptions.ttl) options.ttl = request.promptCacheOptions.ttl;
    if (request.promptCacheOptions.prewarm === true) options.prewarm = true;
    if (Object.keys(options).length > 0) core.prompt_cache_options = options;
  }
  if (request.promptCacheKey) core.prompt_cache_key = request.promptCacheKey;
  const temperature = request.temperature ?? effective.defaults.temperature;
  const topP = request.topP ?? effective.defaults.topP;
  if (temperature !== undefined) core.temperature = temperature;
  if (topP !== undefined) core[effective.fieldMap.topP ?? 'top_p'] = topP;
  void applyThinking;
  return mergeBody(effective, request, core);
}

function usageFrom(value: unknown) {
  const usage = obj(value);
  return {
    inputTokens: num(usage?.input_tokens) ?? 0,
    outputTokens: num(usage?.output_tokens) ?? 0,
    cacheRead: num(obj(usage?.input_tokens_details)?.cached_tokens) ?? 0,
    cacheWrite: 0,
  };
}

function emitOutputItem(emit: Emit, item: Record<string, unknown>): void {
  const type = str(item.type);
  if (type === 'function_call') {
    let input: Record<string, unknown> = {};
    const args = str(item.arguments);
    if (args && args.trim()) {
      try {
        input = obj(JSON.parse(args)) ?? {};
      } catch {
        throw new LLMError('INVALID_REQUEST', `工具 ${str(item.name) ?? ''} 的参数不是合法 JSON`);
      }
    }
    emit({
      type: 'tool_call',
      id: str(item.call_id) ?? str(item.id) ?? 'call_0',
      name: str(item.name) ?? '',
      input,
      ...(str(item.id) ? { itemId: str(item.id) } : {}),
      ...(item.async === true ? { async: true } : {}),
    });
  }
}

async function emitNonStream(ctx: AdapterContext, emit: Emit, json: unknown): Promise<void> {
  const root = obj(json);
  if (!root) throw new LLMError('TRANSPORT', '响应不是对象', { provider: ctx.effective.providerId, model: ctx.effective.id });
  let text = '';
  const output = Array.isArray(root.output) ? root.output : [];
  let hasTool = false;
  for (const raw of output) {
    const item = obj(raw);
    if (!item) continue;
    if (str(item.type) === 'message') {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        const block = obj(part);
        if (str(block?.type) === 'output_text') {
          const piece = str(block?.text) ?? '';
          text += piece;
          if (piece) emit({ type: 'text_delta', text: piece });
        }
      }
    } else if (str(item.type) === 'reasoning') {
      const text = reasoningTextOf(item);
      if (text) emit({ type: 'thinking_delta', text });
      emit({
        type: 'thinking_end',
        text,
        ...(str(item.id) ? { signature: str(item.id) } : {}),
        ...(str(item.encrypted_content) ? { encrypted: str(item.encrypted_content) } : {}),
      });
    } else if (str(item.type) === 'function_call') {
      hasTool = true;
      emitOutputItem(emit, item);
    }
  }
  if (text) emit({ type: 'text_end', text });
  emit({ type: 'usage', ...usageFrom(root.usage) });
  emit({ type: 'done', stopReason: hasTool ? 'tool_use' : mapStopReason(str(root.status)) });
}

export const responsesAdapter: Adapter = {
  async run(ctx: AdapterContext, emit: Emit): Promise<void> {
    const { effective, stream } = ctx;
    const apiKey = resolveApiKey(effective, ctx.env);
    const headers = buildHeaders(effective, apiKey);
    const url = joinUrl(effective.baseUrl, effective.path, '/responses', effective.query);
    const body = buildBody(ctx);
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
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };

    if (!stream) {
      const { json, text } = await requestJson(spec);
      ctx.onRawEvent?.(text);
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

    let text = '';
    let thinking = '';
    let encrypted: string | undefined;
    let reasoningId: string | undefined;
    let hasTool = false;
    const state = { usage: { ...EMPTY_USAGE }, status: undefined as string | undefined };
    const onEvent = (event: RawEvent): void => {
      ctx.onRawEvent?.(event.data);
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      const json = obj(data);
      const type = str(json?.type) ?? event.event;
      if (!type) return;
      if (type === 'response.output_text.delta') {
        const piece = str(json?.delta) ?? '';
        text += piece;
        if (piece) emit({ type: 'text_delta', text: piece });
        return;
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
        const piece = str(json?.delta) ?? '';
        thinking += piece;
        if (piece) emit({ type: 'thinking_delta', text: piece });
        return;
      }
      if (type === 'response.reasoning_text.done') {
        const full = str(json?.text) ?? '';
        if (!thinking && full) thinking = full;
        return;
      }
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        const item = obj(json?.item);
        if (item && str(item.type) === 'reasoning' && type.endsWith('.done')) {
          reasoningId = str(item.id) ?? reasoningId;
          encrypted = str(item.encrypted_content) ?? encrypted;
          if (!thinking) {
            const full = reasoningTextOf(item);
            if (full) {
              thinking = full;
              emit({ type: 'thinking_delta', text: full });
            }
          }
          return;
        }
        if (item && str(item.type) === 'function_call') {
          if (type.endsWith('.added')) {
            emit({ type: 'tool_call_delta', id: str(item.call_id) ?? str(item.id) ?? 'call_0', ...(str(item.name) ? { name: str(item.name) } : {}), argumentsDelta: '' });
          } else {
            hasTool = true;
            emitOutputItem(emit, item);
          }
        }
        return;
      }
      if (type === 'response.function_call_arguments.delta') {
        emit({
          type: 'tool_call_delta',
          id: str(json?.call_id) ?? str(json?.item_id) ?? 'call_0',
          ...(str(json?.name) ? { name: str(json?.name) } : {}),
          argumentsDelta: str(json?.delta) ?? '',
        });
        return;
      }
      if (type === 'response.completed') {
        state.usage = usageFrom(obj(json?.response)?.usage);
        state.status = str(obj(json?.response)?.status);
        return;
      }
      if (type === 'response.failed' || type === 'error') {
        const error = obj(json?.error) ?? obj(obj(json?.response)?.error);
        throw new LLMError('TRANSPORT', str(error?.message) ?? 'responses 流返回 error');
      }
    };
    await readSse(handle, { ...spec }, onEvent);
    if (thinking || encrypted) {
      emit({
        type: 'thinking_end',
        text: thinking,
        ...(reasoningId ? { signature: reasoningId } : {}),
        ...(encrypted ? { encrypted } : {}),
      });
    }
    if (text) emit({ type: 'text_end', text });
    emit({ type: 'usage', ...state.usage });
    emit({ type: 'done', stopReason: hasTool ? 'tool_use' : mapStopReason(state.status) });
  },
};
