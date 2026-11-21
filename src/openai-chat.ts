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
import { applyThinking, buildHeaders, maxTokensField, maxTokensValue, mergeBody, resolveApiKey, samplingBody } from './params.ts';
import { classifyStatus, openStream, readSse, requestJson, type RawEvent } from './transport.ts';
import type { ChatRequest, ContentPart, Message, Usage } from './types.ts';

interface PendingTool {
  id: string;
  name: string;
  args: string;
}

function convertContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } },
  );
}

function convertMessages(effective: AdapterContext['effective'], request: ChatRequest): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (request.system && effective.compat.systemPrompt !== 'field') {
    out.push({ role: 'system', content: request.system });
  }
  for (const message of request.messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: convertContent(message.content), ...effective.messageFields });
    } else if (message.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', ...effective.messageFields };
      if (message.content !== undefined) entry.content = convertContent(message.content);
      if (message.reasoning?.text && effective.capabilities.reasoningContent) {
        entry[effective.fieldMap.reasoningContent ?? 'reasoning_content'] = message.reasoning.text;
      }
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
      }
      out.push(entry);
    } else if (message.role === 'system') {
      if (message.toolChanges || message.outputConfig) {
        throw new LLMError('UNSUPPORTED_FEATURE', '工具变更/逐消息 effort 只在 anthropic-messages 上可用', {
          provider: effective.providerId,
          model: effective.id,
        });
      }
      out.push({ role: 'system', content: convertContent(message.content ?? ''), ...effective.messageFields });
    } else {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: typeof message.content === 'string' ? message.content : convertContent(message.content),
        ...(message.isError === true ? { is_error: true } : {}),
        ...effective.messageFields,
      });
    }
  }
  return out;
}

function convertTools(effective: AdapterContext['effective'], request: ChatRequest): Record<string, unknown>[] | undefined {
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
  return request.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
    ...effective.toolFields,
    ...(deferred.has(tool.name) || tool.deferLoading ? { defer_loading: true } : {}),
  }));
}

function buildBody(ctx: AdapterContext): Record<string, unknown> {
  const { effective, request, stream } = ctx;
  const core: Record<string, unknown> = {
    model: effective.upstream,
    messages: convertMessages(effective, request),
  };
  if (request.system && effective.compat.systemPrompt === 'field') core.system = request.system;
  if (stream) core.stream = true;
  const maxTokens = maxTokensValue(effective, request);
  if (maxTokens !== undefined) core[maxTokensField(effective)] = maxTokens;
  Object.assign(core, samplingBody(effective, request));
  const tools = convertTools(effective, request);
  if (tools) {
    core.tools = tools;
    if (effective.capabilities.parallelToolCalls === false) core.parallel_tool_calls = false;
  }
  Object.assign(core, applyThinking(effective, request, 'openai-chat-completions').openai ?? {});
  if (stream && effective.includeUsage) core.stream_options = { include_usage: true };
  return mergeBody(effective, request, core);
}

function usageFrom(value: unknown): Usage | undefined {
  const usage = obj(value);
  if (!usage) return undefined;
  return {
    inputTokens: num(usage.prompt_tokens) ?? 0,
    outputTokens: num(usage.completion_tokens) ?? 0,
    cacheRead: num(obj(usage.prompt_tokens_details)?.cached_tokens) ?? 0,
    cacheWrite: 0,
  };
}

interface StreamState {
  done: boolean;
  usage?: Usage;
  finishReason?: string;
  text: string;
  thinking: string;
}

function parseChunk(effective: AdapterContext['effective'], data: string, emit: Emit, pending: Map<number, PendingTool>, state: StreamState) {
  if (data === '[DONE]') {
    state.done = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return;
  }
  const json = obj(parsed);
  if (!json) return;
  const usage = usageFrom(json.usage);
  if (usage) state.usage = usage;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = obj(choices[0]);
  if (!choice) return;
  const delta = obj(choice.delta) ?? {};
  const content = delta.content;
  if (typeof content === 'string' && content.length > 0) {
    state.text += content;
    emit({ type: 'text_delta', text: content });
  }
  const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
  if (reasoning) {
    state.thinking += reasoning;
    emit({ type: 'thinking_delta', text: reasoning });
  }
  const calls = delta.tool_calls;
  if (Array.isArray(calls)) {
    for (const raw of calls) {
      const call = obj(raw);
      if (!call) continue;
      const index = num(call.index) ?? 0;
      const fn = obj(call.function) ?? {};
      const current = pending.get(index) ?? { id: str(call.id) ?? `call_${index}`, name: '', args: '' };
      if (str(call.id)) current.id = str(call.id)!;
      if (str(fn.name)) current.name = str(fn.name)!;
      const argsDelta = str(fn.arguments) ?? '';
      current.args += argsDelta;
      pending.set(index, current);
      emit({
        type: 'tool_call_delta',
        id: current.id,
        ...(current.name ? { name: current.name } : {}),
        argumentsDelta: argsDelta,
      });
    }
  }
  const finish = str(choice.finish_reason);
  if (finish) state.finishReason = finish;
  void effective;
}

function flushTools(effective: AdapterContext['effective'], emit: Emit, pending: Map<number, PendingTool>) {
  for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    let input: Record<string, unknown> = {};
    if (call.args.trim().length > 0) {
      try {
        input = obj(JSON.parse(call.args)) ?? {};
      } catch {
        throw new LLMError('INVALID_REQUEST', `工具 ${call.name || index} 的参数不是合法 JSON`, {
          provider: effective.providerId,
          model: effective.id,
        });
      }
    }
    emit({ type: 'tool_call', id: call.id, name: call.name, input });
  }
  pending.clear();
}

async function emitNonStream(ctx: AdapterContext, emit: Emit, json: unknown) {
  const root = obj(json);
  if (!root) throw new LLMError('TRANSPORT', '响应不是对象', { provider: ctx.effective.providerId, model: ctx.effective.id });
  const choice = obj(Array.isArray(root.choices) ? root.choices[0] : undefined);
  if (!choice) throw new LLMError('EMPTY_RESPONSE', '响应没有 choices', { provider: ctx.effective.providerId, model: ctx.effective.id });
  const message = obj(choice.message) ?? {};
  const text = str(message.content);
  if (text) {
    emit({ type: 'text_delta', text });
    emit({ type: 'text_end', text });
  }
  const reasoning = str(message.reasoning_content) ?? str(message.reasoning);
  if (reasoning) {
    emit({ type: 'thinking_delta', text: reasoning });
    emit({ type: 'thinking_end', text: reasoning });
  }
  const calls = message.tool_calls;
  if (Array.isArray(calls)) {
    calls.forEach((raw, index) => {
      const call = obj(raw);
      const fn = obj(call?.function) ?? {};
      const name = str(fn.name) ?? '';
      let input: Record<string, unknown> = {};
      const args = str(fn.arguments);
      if (args && args.trim()) {
        try {
          input = obj(JSON.parse(args)) ?? {};
        } catch {
          throw new LLMError('INVALID_REQUEST', `工具 ${name} 的参数不是合法 JSON`, { provider: ctx.effective.providerId, model: ctx.effective.id });
        }
      }
      emit({ type: 'tool_call', id: str(call?.id) ?? `call_${index}`, name, input });
    });
  }
  const usage = usageFrom(root.usage) ?? EMPTY_USAGE;
  emit({ type: 'usage', ...usage });
  emit({ type: 'done', stopReason: mapStopReason(str(choice.finish_reason)) });
}

export const openaiChatAdapter: Adapter = {
  async run(ctx: AdapterContext, emit: Emit): Promise<void> {
    const { effective, request, stream } = ctx;
    const apiKey = resolveApiKey(effective, ctx.env);
    const headers = buildHeaders(effective, apiKey);
    const url = joinUrl(effective.baseUrl, effective.path, '/chat/completions', effective.query);
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
      const json = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return undefined;
        }
      })();
      if (json) {
        await emitNonStream(ctx, emit, json);
        return;
      }
      throw classifyStatus(handle.response.status, text, { ...spec });
    }

    const pending = new Map<number, PendingTool>();
    const state: StreamState = {
      done: false,
      text: '',
      thinking: '',
    };
    const onEvent = (event: RawEvent): void => {
      ctx.onRawEvent?.(event.data);
      parseChunk(effective, event.data, emit, pending, state);
    };
    await readSse(handle, { ...spec }, onEvent);
    flushTools(effective, emit, pending);
    if (state.thinking) emit({ type: 'thinking_end', text: state.thinking });
    if (state.text) emit({ type: 'text_end', text: state.text });
    const usage = state.usage ?? EMPTY_USAGE;
    emit({ type: 'usage', ...usage });
    emit({ type: 'done', stopReason: mapStopReason(state.finishReason) });
  },
};
