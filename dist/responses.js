import { LLMError } from "./errors.js";
import { EMPTY_USAGE, joinUrl, num, obj, str, } from "./adapter.js";
import { buildHeaders, maxTokensValue, resolveApiKey } from "./params.js";
import { classifyStatus, openStream, readSse, requestJson } from "./transport.js";
/** OpenAI Responses rejects max_output_tokens values below 16. */
export const MIN_OUTPUT_TOKENS = 16;
function inputContent(content, role) {
    if (typeof content === 'string') {
        return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
    }
    return content.map((part) => part.type === 'text'
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
        : { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` });
}
function reasoningTextOf(item) {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    const summaryText = summary.map((part) => str(obj(part)?.text) ?? '').join('\n\n');
    if (summaryText)
        return summaryText;
    const content = Array.isArray(item.content) ? item.content : [];
    return content.map((part) => str(obj(part)?.text) ?? '').join('\n\n');
}
function convertInput(effective, request) {
    const items = [];
    if (request.system && effective.compat.systemPrompt === 'message') {
        items.push({ role: 'user', content: [{ type: 'input_text', text: request.system }] });
    }
    for (const message of request.messages) {
        if (message.role === 'user') {
            items.push({ role: 'user', content: inputContent(message.content, 'user') });
        }
        else if (message.role === 'assistant') {
            if (message.content !== undefined)
                items.push({ role: 'assistant', content: inputContent(message.content, 'assistant') });
            if (message.reasoning?.item) {
                items.push(message.reasoning.item);
            }
            else if (message.reasoning?.encrypted) {
                items.push({
                    type: 'reasoning',
                    ...(message.reasoning.signature ? { id: message.reasoning.signature } : {}),
                    encrypted_content: message.reasoning.encrypted,
                });
            }
            else if (message.reasoning?.text && effective.capabilities.reasoningContent) {
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
        }
        else if (message.role === 'system') {
            if (message.toolChanges || message.outputConfig) {
                throw new LLMError('UNSUPPORTED_FEATURE', '工具变更/逐消息 effort 只在 anthropic-messages 上可用', {
                    provider: effective.providerId,
                    model: effective.id,
                });
            }
            items.push({ role: 'system', content: inputContent(message.content ?? '', 'system') });
        }
        else {
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
function convertTools(effective, request) {
    const tools = (request.tools ?? []).map((tool) => ({
        type: 'function',
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
        ...(tool.async === true ? { async: true } : {}),
        ...effective.toolFields,
    }));
    if (request.serverWebSearch === true)
        tools.push({ type: 'web_search' });
    return tools.length > 0 ? tools : undefined;
}
function buildBody(ctx) {
    const { effective, request, stream } = ctx;
    const core = {
        model: effective.upstream,
        input: convertInput(effective, request),
    };
    if (request.system && effective.compat.systemPrompt !== 'message') {
        const suffix = request.systemSuffix?.trim();
        core.instructions = suffix ? `${request.system}\n\n${suffix}` : request.system;
    }
    if (stream)
        core.stream = true;
    const maxTokens = maxTokensValue(effective, request);
    if (maxTokens !== undefined) {
        const field = effective.compat.maxTokensField ?? effective.fieldMap.maxTokens ?? 'max_output_tokens';
        core[field] = Math.max(maxTokens, MIN_OUTPUT_TOKENS);
    }
    const tools = convertTools(effective, request);
    if (tools)
        core.tools = tools;
    if (effective.capabilities.responsesEncryptedReplay)
        core.include = ['reasoning.encrypted_content'];
    if (request.effort && effective.capabilities.thinkingStyle)
        core.reasoning = { effort: request.effort };
    if (request.jsonMode === true)
        core.text = { format: { type: 'json_object' } };
    if (request.promptCacheOptions) {
        const options = {};
        if (request.promptCacheOptions.mode)
            options.mode = request.promptCacheOptions.mode;
        if (request.promptCacheOptions.ttl)
            options.ttl = request.promptCacheOptions.ttl;
        if (request.promptCacheOptions.prewarm === true)
            options.prewarm = true;
        if (Object.keys(options).length > 0)
            core.prompt_cache_options = options;
    }
    if (request.promptCacheKey)
        core.prompt_cache_key = request.promptCacheKey;
    const temperature = request.temperature ?? effective.defaults.temperature;
    const topP = request.topP ?? effective.defaults.topP;
    if (temperature !== undefined)
        core.temperature = temperature;
    if (topP !== undefined)
        core[effective.fieldMap.topP ?? 'top_p'] = topP;
    return { ...effective.extraBody, ...core, ...(request.extra ?? {}) };
}
function usageFrom(value) {
    const usage = obj(value);
    const inputTokens = num(usage?.input_tokens);
    const outputTokens = num(usage?.output_tokens);
    if (inputTokens === undefined && outputTokens === undefined) {
        return { ...EMPTY_USAGE, seen: false };
    }
    const cached = num(obj(usage?.input_tokens_details)?.cached_tokens) ?? 0;
    const cacheWrite = num(obj(usage?.input_tokens_details)?.cache_write_tokens) ?? 0;
    if (!Number.isSafeInteger(cached) || cached < 0) {
        throw new LLMError('TRANSPORT', 'Responses 返回了非法的 cached_tokens');
    }
    if (!Number.isSafeInteger(cacheWrite) || cacheWrite < 0) {
        throw new LLMError('TRANSPORT', 'Responses 返回了非法的 cache_write_tokens');
    }
    return {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cacheRead: cached,
        cacheWrite,
        seen: true,
    };
}
function rememberCall(calls, itemId, item, outputIndex) {
    let key = itemId ?? item?.id ?? item?.call_id ?? (outputIndex !== undefined ? `idx-${outputIndex}` : `unknown-${calls.size}`);
    let call = calls.get(key);
    // output_item.added 用 fc_ id，参数 delta 常只带 call_id；两者必须收敛到同一个槽位，
    // 否则同一次工具调用会在收尾时被发成两条。
    if (!call && item?.call_id) {
        const linked = [...calls.entries()].find(([, existing]) => existing.callId === item.call_id);
        if (linked) {
            key = linked[0];
            call = linked[1];
        }
    }
    if (!call) {
        call = { callId: item?.call_id ?? key, name: item?.name ?? '', args: '' };
        calls.set(key, call);
    }
    if (item?.call_id)
        call.callId = item.call_id;
    if (item?.id)
        call.itemId = item.id;
    if (item?.name)
        call.name = item.name;
    if (item?.async === true)
        call.async = true;
    return call;
}
function emitCall(emit, call) {
    let input = {};
    if (call.args.trim()) {
        try {
            input = obj(JSON.parse(call.args)) ?? {};
        }
        catch {
            throw new LLMError('INVALID_REQUEST', `工具 ${call.name} 的参数不是合法 JSON（流可能被截断）`);
        }
    }
    emit({
        type: 'tool_call',
        id: call.callId,
        name: call.name,
        input,
        ...(call.itemId ? { itemId: call.itemId } : {}),
        ...(call.async === true ? { async: true } : {}),
    });
}
function emitWebSearch(emit, state, item) {
    const id = str(item.id);
    if (id && state.webSearchFinished.has(id))
        return;
    if (id)
        state.webSearchFinished.set(id, item);
    emit({ type: 'web_search_call', item });
}
function finishReasoning(emit, state, item, fallbackText) {
    const text = reasoningTextOf(item) || fallbackText || '';
    const id = str(item.id);
    if (id && state.reasoningFinished.has(id))
        return;
    if (id)
        state.reasoningFinished.set(id, { text, item });
    emit({
        type: 'thinking_end',
        text,
        item,
        ...(id ? { signature: id } : {}),
        ...(str(item.encrypted_content) ? { encrypted: str(item.encrypted_content) } : {}),
    });
}
function finishText(emit, state, acc, authoritative) {
    const text = authoritative ?? acc.text;
    if (acc.ended)
        return;
    acc.ended = true;
    if (acc.itemId)
        state.endedTextIds.add(acc.itemId);
    state.textEndEmitted = true;
    emit({
        type: 'text_end',
        text,
        ...(acc.itemId ? { itemId: acc.itemId } : {}),
        ...(acc.phase ? { phase: acc.phase } : {}),
    });
}
function handleOutputItem(emit, state, item, done, outputIndex) {
    const type = str(item.type);
    if (type === 'reasoning') {
        if (done) {
            const index = outputIndex ?? 0;
            const acc = state.reasoningAccums.get(index);
            state.reasoningAccums.delete(index);
            finishReasoning(emit, state, item, acc?.text);
            return;
        }
        if (outputIndex !== undefined) {
            state.reasoningAccums.set(outputIndex, { ...(str(item.id) ? { id: str(item.id) } : {}), text: '' });
        }
        return;
    }
    if (type === 'web_search_call' && done) {
        emitWebSearch(emit, state, item);
        return;
    }
    if (type === 'function_call') {
        const call = rememberCall(state.calls, str(item.id), item, outputIndex);
        if (str(item.arguments))
            call.args = str(item.arguments);
        if (!done) {
            emit({
                type: 'tool_call_delta',
                id: call.callId,
                ...(call.name ? { name: call.name } : {}),
                argumentsDelta: '',
            });
        }
        return;
    }
    if (type === 'message') {
        const index = outputIndex ?? 0;
        const acc = state.texts.get(index) ?? { text: '', ended: false };
        if (str(item.id))
            acc.itemId = str(item.id);
        if (str(item.phase))
            acc.phase = str(item.phase);
        state.texts.set(index, acc);
        if (done) {
            const content = Array.isArray(item.content) ? item.content : [];
            const authoritative = content
                .map((part) => {
                const block = obj(part);
                if (str(block?.type) === 'refusal')
                    return str(block?.refusal) ?? '';
                return str(block?.text) ?? '';
            })
                .join('');
            if (authoritative.startsWith(acc.text) && authoritative.length > acc.text.length) {
                emit({ type: 'text_delta', text: authoritative.slice(acc.text.length) });
                acc.text = authoritative;
            }
            finishText(emit, state, acc, authoritative || acc.text);
        }
    }
}
function handleCompleted(emit, state, response) {
    state.finalStatus = str(response.status) ?? state.finalStatus;
    state.incompleteReason = str(obj(response.incomplete_details)?.reason) ?? state.incompleteReason;
    const usage = usageFrom(response.usage);
    if (usage.seen)
        state.usage = usage;
    const output = Array.isArray(response.output) ? response.output : [];
    for (const raw of output) {
        const item = obj(raw);
        if (!item)
            continue;
        const type = str(item.type);
        if (type === 'function_call') {
            const call = rememberCall(state.calls, str(item.id), item);
            if (str(item.arguments))
                call.args = str(item.arguments);
        }
        else if (type === 'web_search_call') {
            emitWebSearch(emit, state, item);
        }
        else if (type === 'reasoning') {
            const id = str(item.id);
            const finished = id ? state.reasoningFinished.get(id) : undefined;
            if (finished) {
                const encrypted = str(item.encrypted_content);
                const storedEncrypted = str(finished.item.encrypted_content);
                if (encrypted && !storedEncrypted) {
                    const merged = { ...finished.item, encrypted_content: encrypted };
                    finished.item = merged;
                    emit({ type: 'thinking_end', text: finished.text, item: merged, ...(id ? { signature: id } : {}), encrypted });
                }
            }
            else {
                const match = [...state.reasoningAccums.entries()].find(([, acc]) => acc.id === id);
                if (match)
                    state.reasoningAccums.delete(match[0]);
                finishReasoning(emit, state, item, match?.[1].text);
            }
        }
        else if (type === 'message') {
            const id = str(item.id);
            if (id && state.endedTextIds.has(id))
                continue;
            const existing = id
                ? [...state.texts.entries()].find(([, acc]) => acc.itemId === id)
                : undefined;
            if (existing?.[1].ended)
                continue;
            const index = existing?.[0] ?? state.texts.size;
            handleOutputItem(emit, state, item, true, index);
        }
    }
}
function doneReason(state) {
    if (state.finalStatus === 'incomplete' && state.incompleteReason === 'max_output_tokens')
        return 'max_tokens';
    if (state.finalStatus === 'failed')
        return 'error';
    if (state.sawRefusal)
        return 'refusal';
    if (state.calls.size > 0)
        return 'tool_use';
    if (state.finalStatus === 'completed')
        return 'end_turn';
    if (state.sawStreamEnd && (state.sawText || state.texts.size > 0))
        return 'end_turn';
    return 'error';
}
function emitNonStream(ctx, emit, json) {
    const root = obj(json);
    if (!root)
        throw new LLMError('TRANSPORT', '响应不是对象', { provider: ctx.effective.providerId, model: ctx.effective.id });
    const state = {
        calls: new Map(),
        texts: new Map(),
        reasoningAccums: new Map(),
        reasoningFinished: new Map(),
        webSearchFinished: new Map(),
        usage: { ...EMPTY_USAGE, seen: false },
        sawRefusal: false,
        sawText: false,
        sawStreamEnd: true,
        finalStatus: str(root.status),
        textEndEmitted: false,
        endedTextIds: new Set(),
    };
    handleCompleted(emit, state, root);
    for (const call of state.calls.values())
        emitCall(emit, call);
    if (state.usage.seen)
        emit({ type: 'usage', ...state.usage });
    else
        emit({ type: 'usage', ...EMPTY_USAGE });
    emit({ type: 'done', stopReason: doneReason(state) });
}
export const responsesAdapter = {
    async run(ctx, emit) {
        const { effective, request, stream } = ctx;
        const apiKey = resolveApiKey(effective, ctx.env);
        const headers = buildHeaders(effective, apiKey, request.headers);
        const url = joinUrl(effective.baseUrl, effective.path, '/responses', effective.query);
        const body = request.rawBody
            ? { ...request.rawBody, ...(stream ? { stream: true } : {}) }
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
            emitNonStream(ctx, emit, json);
            return;
        }
        const handle = await openStream(spec);
        const contentType = handle.response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
            const text = await handle.response.text().catch(() => '');
            handle.close();
            ctx.onRawEvent?.(text);
            let json;
            try {
                json = JSON.parse(text);
            }
            catch {
                throw classifyStatus(handle.response.status, text, { ...spec });
            }
            emitNonStream(ctx, emit, json);
            return;
        }
        const state = {
            calls: new Map(),
            texts: new Map(),
            reasoningAccums: new Map(),
            reasoningFinished: new Map(),
            webSearchFinished: new Map(),
            usage: { ...EMPTY_USAGE, seen: false },
            sawRefusal: false,
            sawText: false,
            sawStreamEnd: false,
            textEndEmitted: false,
            endedTextIds: new Set(),
        };
        const onEvent = (event) => {
            ctx.onRawEvent?.(event.data);
            if (event.data === '[DONE]') {
                state.sawStreamEnd = true;
                return;
            }
            let data;
            try {
                data = JSON.parse(event.data);
            }
            catch {
                return;
            }
            const json = obj(data);
            const type = str(json?.type) ?? event.event;
            if (!type)
                return;
            const outputIndex = num(json?.output_index);
            if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
                const piece = str(json?.delta) ?? (type === 'response.refusal.delta' ? str(json?.refusal) : undefined) ?? '';
                if (type === 'response.refusal.delta')
                    state.sawRefusal = true;
                const index = outputIndex ?? 0;
                const acc = state.texts.get(index) ?? { text: '', ended: false };
                if (str(json?.item_id))
                    acc.itemId = str(json?.item_id);
                acc.text += piece;
                state.texts.set(index, acc);
                if (piece) {
                    if (type === 'response.refusal.delta')
                        state.sawRefusal = true;
                    else
                        state.sawText = true;
                    emit({ type: 'text_delta', text: piece });
                }
                return;
            }
            if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
                const piece = str(json?.delta) ?? '';
                if (!piece)
                    return;
                if (outputIndex !== undefined) {
                    const acc = state.reasoningAccums.get(outputIndex) ?? { text: '' };
                    acc.text += piece;
                    state.reasoningAccums.set(outputIndex, acc);
                }
                emit({ type: 'thinking_delta', text: piece });
                return;
            }
            if (type === 'response.reasoning_summary_part.done') {
                if (outputIndex !== undefined) {
                    const acc = state.reasoningAccums.get(outputIndex) ?? { text: '' };
                    acc.text += '\n\n';
                    state.reasoningAccums.set(outputIndex, acc);
                }
                emit({ type: 'thinking_delta', text: '\n\n' });
                return;
            }
            if (type === 'response.reasoning_text.done') {
                const full = str(json?.text) ?? '';
                if (full && outputIndex !== undefined) {
                    const acc = state.reasoningAccums.get(outputIndex) ?? { text: '' };
                    if (!acc.text)
                        acc.text = full;
                    state.reasoningAccums.set(outputIndex, acc);
                }
                return;
            }
            if (type === 'response.web_search_call.in_progress') {
                emit({ type: 'server_tool', tool: 'web_search', phase: 'start' });
                return;
            }
            if (type === 'response.web_search_call.searching') {
                emit({ type: 'server_tool', tool: 'web_search', phase: 'update' });
                return;
            }
            if (type === 'response.web_search_call.completed') {
                emit({ type: 'server_tool', tool: 'web_search', phase: 'end' });
                return;
            }
            if (type === 'response.output_item.added' || type === 'response.output_item.done') {
                const item = obj(json?.item);
                if (!item)
                    return;
                if (type.endsWith('.done') && str(item.type) === 'reasoning') {
                    const index = outputIndex ?? 0;
                    const acc = state.reasoningAccums.get(index);
                    if (acc && str(item.id))
                        acc.id = str(item.id);
                    state.reasoningAccums.delete(index);
                    finishReasoning(emit, state, item, acc?.text);
                    return;
                }
                if (type.endsWith('.done') && str(item.type) === 'message') {
                    const index = outputIndex ?? 0;
                    const acc = state.texts.get(index) ?? { text: '', ended: false };
                    if (str(item.id))
                        acc.itemId = str(item.id);
                    if (str(item.phase))
                        acc.phase = str(item.phase);
                    state.texts.set(index, acc);
                }
                handleOutputItem(emit, state, item, type.endsWith('.done'), outputIndex);
                return;
            }
            if (type === 'response.function_call_arguments.delta') {
                const itemId = str(json?.item_id);
                const callId = str(json?.call_id);
                const call = rememberCall(state.calls, itemId, { ...(callId ? { call_id: callId } : {}), ...(str(json?.name) ? { name: str(json?.name) } : {}) }, outputIndex);
                const delta = str(json?.delta) ?? '';
                call.args += delta;
                emit({
                    type: 'tool_call_delta',
                    id: call.callId,
                    ...(call.name ? { name: call.name } : {}),
                    argumentsDelta: delta,
                });
                return;
            }
            if (type === 'response.function_call_arguments.done') {
                const itemId = str(json?.item_id);
                const callId = str(json?.call_id);
                const call = rememberCall(state.calls, itemId, { ...(callId ? { call_id: callId } : {}), ...(str(json?.name) ? { name: str(json?.name) } : {}) }, outputIndex);
                if (str(json?.arguments))
                    call.args = str(json?.arguments);
                return;
            }
            if (type === 'response.completed' || type === 'response.incomplete') {
                const response = obj(json?.response);
                if (response)
                    handleCompleted(emit, state, response);
                return;
            }
            if (type === 'response.failed' || type === 'error') {
                const responseError = obj(obj(json?.response)?.error);
                const error = obj(json?.error) ?? responseError;
                const message = str(error?.message) ?? str(json?.message) ?? 'responses 流返回 error';
                throw new LLMError('TRANSPORT', message, {
                    provider: effective.providerId,
                    model: effective.id,
                    ...(num(error?.status) !== undefined ? { status: num(error?.status) } : {}),
                });
            }
        };
        await readSse(handle, { ...spec }, onEvent);
        const emittedIds = new Set();
        for (const call of state.calls.values()) {
            if (emittedIds.has(call.callId))
                continue;
            emittedIds.add(call.callId);
            emitCall(emit, call);
        }
        // 端点只给 delta、没有 message item 收尾时，仍给出一条权威 text_end（OWC 落盘 textSignature 用）。
        if (!state.textEndEmitted && state.sawText) {
            const aggregate = [...state.texts.values()].map((acc) => acc.text).join('');
            if (aggregate)
                emit({ type: 'text_end', text: aggregate });
        }
        if (state.usage.seen)
            emit({ type: 'usage', ...state.usage });
        else
            emit({ type: 'usage', ...EMPTY_USAGE });
        emit({ type: 'done', stopReason: doneReason(state) });
    },
};
