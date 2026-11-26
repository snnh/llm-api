import { LLMError } from "./errors.js";
import { EMPTY_USAGE, joinUrl, num, obj, str, } from "./adapter.js";
import { buildHeaders, isPresent, maxTokensValue, mergeBody, resolveApiKey } from "./params.js";
import { classifyStatus, openStream, readSse, requestJson } from "./transport.js";
/**
 * Native Gemini `generateContent` / `streamGenerateContent` wire.
 *
 * The endpoint is model-scoped, so the path is built here instead of being a
 * static provider default. `path` may use `{model}` and `{method}` placeholders
 * for gateways that mount Gemini behind a different route.
 */
function requestUrl(effective, stream) {
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const upstream = effective.upstream.replace(/^models\//, '');
    const fallback = `/models/${encodeURIComponent(upstream)}:${method}`;
    const path = effective.path
        ? effective.path
            .replaceAll('{model}', encodeURIComponent(upstream))
            .replaceAll('{method}', method)
        : fallback;
    const query = { ...(effective.query ?? {}) };
    if (stream)
        query.alt = 'sse';
    return joinUrl(effective.baseUrl, path, fallback, query);
}
function contentParts(content) {
    if (content === undefined)
        return [];
    if (typeof content === 'string')
        return content.length > 0 ? [{ text: content }] : [];
    return content.map((part) => part.type === 'text'
        ? { text: part.text, ...(part.signature ? { thoughtSignature: part.signature } : {}) }
        : { inlineData: { mimeType: part.mediaType, data: part.data } });
}
function systemTexts(effective, request) {
    const texts = [];
    if (request.system?.length)
        texts.push(request.system);
    for (const message of request.messages) {
        if (message.role !== 'system')
            continue;
        if (message.toolChanges || message.outputConfig) {
            throw new LLMError('UNSUPPORTED_FEATURE', '工具变更/逐消息 effort 只在 anthropic-messages 上可用', {
                provider: effective.providerId,
                model: effective.id,
            });
        }
        if (message.content === undefined)
            continue;
        if (typeof message.content === 'string') {
            if (message.content.length)
                texts.push(message.content);
            continue;
        }
        for (const part of message.content) {
            if (part.type !== 'text') {
                throw new LLMError('UNSUPPORTED_FEATURE', 'Gemini systemInstruction 只支持文本', {
                    provider: effective.providerId,
                    model: effective.id,
                });
            }
            if (part.text.length)
                texts.push(part.text);
        }
    }
    if (request.systemSuffix?.length)
        texts.push(request.systemSuffix);
    return texts;
}
function toolResponse(content, isError) {
    let value;
    if (typeof content === 'string') {
        const text = content;
        try {
            value = JSON.parse(text);
        }
        catch {
            value = text;
        }
    }
    else {
        if (content.some((part) => part.type !== 'text')) {
            throw new LLMError('UNSUPPORTED_FEATURE', 'Gemini functionResponse 暂不支持图片/视频结果');
        }
        const text = content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
        try {
            value = JSON.parse(text);
        }
        catch {
            value = text;
        }
    }
    if (isError) {
        return { error: typeof value === 'string' ? value : JSON.stringify(value) };
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (value === undefined || value === '')
        return {};
    return { result: value };
}
function convertMessages(request, systemAsMessage, texts) {
    const contents = [];
    const toolNames = new Map();
    const toolProviderIds = new Map();
    const push = (role, parts) => {
        if (parts.length === 0)
            return;
        const last = contents.at(-1);
        if (last?.role === role)
            last.parts.push(...parts);
        else
            contents.push({ role, parts });
    };
    for (const message of request.messages) {
        if (message.role === 'user') {
            push('user', contentParts(message.content));
        }
        else if (message.role === 'assistant') {
            const parts = contentParts(message.content);
            for (const call of message.toolCalls ?? []) {
                toolNames.set(call.id, call.name);
                if (call.providerId)
                    toolProviderIds.set(call.id, call.providerId);
                parts.push({
                    functionCall: {
                        ...(call.providerId ? { id: call.providerId } : {}),
                        name: call.name,
                        args: call.input ?? {},
                    },
                    ...(call.signature ? { thoughtSignature: call.signature } : {}),
                });
            }
            push('model', parts);
        }
        else if (message.role === 'tool') {
            const name = message.name ?? toolNames.get(message.toolCallId);
            if (!name) {
                throw new LLMError('INVALID_REQUEST', `Gemini 工具结果缺少工具名：${message.toolCallId}`);
            }
            const providerId = toolProviderIds.get(message.toolCallId);
            push('user', [
                {
                    functionResponse: {
                        ...(providerId ? { id: providerId } : {}),
                        name,
                        response: toolResponse(message.content, message.isError === true),
                    },
                },
            ]);
        }
        // system messages are folded into systemInstruction (or the first user turn).
    }
    if (texts.length > 0 && systemAsMessage) {
        const parts = texts.map((text) => ({ text }));
        const firstUser = contents.find((content) => content.role === 'user');
        if (firstUser)
            firstUser.parts.unshift(...parts);
        else
            contents.unshift({ role: 'user', parts });
    }
    return contents;
}
function declarations(effective, request) {
    if (!request.tools?.length)
        return undefined;
    if (!effective.force && effective.capabilities.tools === false) {
        throw new LLMError('INVALID_REQUEST', `模型 ${effective.id} 未声明 tools 能力`, {
            provider: effective.providerId,
            model: effective.id,
        });
    }
    if (request.deferredTools?.length || request.tools.some((tool) => tool.deferLoading)) {
        throw new LLMError('UNSUPPORTED_FEATURE', 'Gemini generateContent 不支持延迟加载工具', {
            provider: effective.providerId,
            model: effective.id,
        });
    }
    return request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters,
        ...effective.toolFields,
    }));
}
function thinkingConfig(effective, request) {
    const style = effective.capabilities.thinkingStyle;
    if (!style || style === 'enable_thinking')
        return undefined;
    if (request.thinking === 'disabled' && style === 'effort_only') {
        throw new LLMError('INVALID_REQUEST', 'thinkingStyle: effort_only 的模型没有 thinking: disabled 形态', {
            provider: effective.providerId,
            model: effective.id,
        });
    }
    const out = {};
    if (request.thinking === 'disabled') {
        out.thinkingBudget = 0;
        out.includeThoughts = false;
    }
    else {
        if (isPresent(request.effort) && (style === 'effort_only' || style === 'adaptive')) {
            out.thinkingLevel = request.effort;
        }
        else if (isPresent(request.thinkingBudgetTokens)) {
            out.thinkingBudget = request.thinkingBudgetTokens;
        }
        if (request.thinking)
            out.includeThoughts = true;
        else if (style === 'fixed' || style === 'adaptive')
            out.includeThoughts = true;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function buildGenerationConfig(effective, request) {
    const staticConfig = obj(effective.extraBody.generationConfig);
    const config = { ...(staticConfig ?? {}) };
    const maxTokens = maxTokensValue(effective, request);
    if (maxTokens !== undefined)
        config[effective.compat.maxTokensField ?? effective.fieldMap.maxTokens ?? 'maxOutputTokens'] = maxTokens;
    const temperature = request.temperature ?? effective.defaults.temperature;
    const topP = request.topP ?? effective.defaults.topP;
    const topK = request.topK ?? effective.defaults.topK;
    if (isPresent(temperature))
        config.temperature = temperature;
    if (isPresent(topP))
        config[effective.fieldMap.topP ?? 'topP'] = topP;
    if (isPresent(topK))
        config[effective.fieldMap.topK ?? 'topK'] = topK;
    if (isPresent(request.stop))
        config.stopSequences = request.stop;
    if (isPresent(request.seed))
        config.seed = request.seed;
    if (request.jsonMode === true)
        config.responseMimeType = 'application/json';
    const thinking = thinkingConfig(effective, request);
    if (thinking)
        config.thinkingConfig = thinking;
    const extraConfig = obj(request.extra?.generationConfig);
    if (extraConfig)
        Object.assign(config, extraConfig);
    return Object.keys(config).length > 0 ? config : undefined;
}
function rejectsStreamingFunctionArgs(effective, request) {
    const roots = request.rawBody
        ? [request.rawBody.toolConfig]
        : [
            effective.extraBody.toolConfig,
            request.extra?.toolConfig,
            request.toolConfig,
        ];
    return roots.some((root) => {
        const config = obj(root)?.functionCallingConfig;
        return obj(config)?.streamFunctionCallArguments === true;
    });
}
function buildBody(ctx) {
    const { effective, request } = ctx;
    const systemAsMessage = effective.compat.systemPrompt === 'message';
    const texts = systemTexts(effective, request);
    const contents = convertMessages(request, systemAsMessage, texts);
    const systemInstruction = !systemAsMessage && texts.length > 0
        ? { parts: texts.map((text) => ({ text })) }
        : undefined;
    const core = { contents };
    if (systemInstruction)
        core.systemInstruction = systemInstruction;
    const toolDeclarations = declarations(effective, request);
    if (toolDeclarations)
        core.tools = [{ functionDeclarations: toolDeclarations }];
    const generationConfig = buildGenerationConfig(effective, request);
    const body = mergeBody(effective, request, core);
    // Gemini's own shape is owned by this adapter, not by generic extra/extraBody.
    body.contents = contents;
    if (systemInstruction)
        body.systemInstruction = systemInstruction;
    else
        delete body.systemInstruction;
    if (generationConfig)
        body.generationConfig = generationConfig;
    else
        delete body.generationConfig;
    return body;
}
function usageFrom(value, base) {
    const usage = obj(value);
    if (!usage)
        return base;
    const candidates = num(usage.candidatesTokenCount);
    const thoughts = num(usage.thoughtsTokenCount);
    return {
        inputTokens: num(usage.promptTokenCount) ?? base.inputTokens,
        outputTokens: candidates === undefined && thoughts === undefined ? base.outputTokens : (candidates ?? 0) + (thoughts ?? 0),
        cacheRead: num(usage.cachedContentTokenCount) ?? base.cacheRead,
        cacheWrite: 0,
    };
}
function mapFinishReason(reason, hasToolCalls, sawOutput) {
    switch (reason) {
        case 'STOP':
            return hasToolCalls ? 'tool_use' : 'end_turn';
        case 'MAX_TOKENS':
        case 'CONTINUATION':
            return 'max_tokens';
        case 'SAFETY':
        case 'RECITATION':
        case 'LANGUAGE':
        case 'BLOCKLIST':
        case 'PROHIBITED_CONTENT':
        case 'SPII':
        case 'IMAGE_SAFETY':
        case 'IMAGE_PROHIBITED_CONTENT':
        case 'IMAGE_RECITATION':
        case 'PUP_LIMITED_DISABLED':
            return 'refusal';
        case 'MALFORMED_FUNCTION_CALL':
        case 'UNEXPECTED_TOOL_CALL':
        case 'TOO_MANY_TOOL_CALLS':
        case 'MISSING_THOUGHT_SIGNATURE':
        case 'MALFORMED_RESPONSE':
        case 'OTHER':
            return 'error';
        default:
            if (hasToolCalls)
                return 'tool_use';
            if (sawOutput)
                return 'end_turn';
            return 'error';
    }
}
function emptyState() {
    return {
        text: '',
        thinking: '',
        toolCalls: 0,
        usage: { ...EMPTY_USAGE },
        sawOutput: false,
    };
}
function functionInput(value) {
    if (typeof value === 'string') {
        try {
            return obj(JSON.parse(value)) ?? {};
        }
        catch {
            throw new LLMError('INVALID_REQUEST', 'Gemini functionCall.args 不是合法 JSON');
        }
    }
    return obj(value) ?? {};
}
function processCandidate(candidate, emit, state) {
    const content = obj(candidate.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const raw of parts) {
        const part = obj(raw);
        if (!part)
            continue;
        const text = str(part.text);
        const signature = str(part.thoughtSignature);
        if (text !== undefined) {
            if (part.thought === true) {
                if (signature) {
                    state.thinkingSignature = signature;
                    state.sawOutput = true;
                }
                if (text.length > 0) {
                    state.sawOutput = true;
                    state.thinking += text;
                    emit({ type: 'thinking_delta', text });
                }
            }
            else {
                if (signature) {
                    state.textSignature = signature;
                    state.sawOutput = true;
                }
                if (text.length > 0) {
                    state.sawOutput = true;
                    state.text += text;
                    emit({ type: 'text_delta', text });
                }
            }
        }
        const call = obj(part.functionCall);
        if (call) {
            const name = str(call.name);
            if (!name)
                continue;
            const input = functionInput(call.args);
            const providerId = str(call.id);
            state.sawOutput = true;
            state.toolCalls += 1;
            emit({
                type: 'tool_call',
                id: providerId ?? `call_${state.toolCalls}`,
                name,
                input,
                ...(signature ? { signature } : {}),
                ...(providerId ? { providerId } : {}),
            });
        }
    }
    if (str(candidate.finishReason))
        state.finishReason = str(candidate.finishReason);
    if (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.some((rating) => obj(rating)?.blocked === true)) {
        state.blocked = 'SAFETY';
    }
}
function processRoot(root, emit, state) {
    const candidate = obj(Array.isArray(root.candidates) ? root.candidates[0] : undefined);
    if (candidate)
        processCandidate(candidate, emit, state);
    const feedback = obj(root.promptFeedback);
    const block = str(feedback?.blockReason);
    if (block)
        state.blocked = block;
    state.usage = usageFrom(root.usageMetadata, state.usage);
}
function finalize(emit, state) {
    if (state.thinking || state.thinkingSignature) {
        emit({
            type: 'thinking_end',
            text: state.thinking,
            ...(state.thinkingSignature ? { signature: state.thinkingSignature } : {}),
        });
    }
    if (state.text || state.textSignature) {
        emit({
            type: 'text_end',
            text: state.text,
            ...(state.textSignature ? { signature: state.textSignature } : {}),
        });
    }
    emit({ type: 'usage', ...state.usage });
    emit({
        type: 'done',
        stopReason: state.blocked
            ? 'refusal'
            : mapFinishReason(state.finishReason, state.toolCalls > 0, state.sawOutput),
    });
}
function emitJson(ctx, emit, json) {
    const values = Array.isArray(json) ? json : [json];
    const state = emptyState();
    for (const value of values) {
        const root = obj(value);
        if (!root) {
            throw new LLMError('TRANSPORT', 'Gemini 响应不是对象', {
                provider: ctx.effective.providerId,
                model: ctx.effective.id,
            });
        }
        processRoot(root, emit, state);
    }
    if (!state.sawOutput && !state.textSignature && !state.thinkingSignature && !state.blocked && !state.finishReason) {
        throw new LLMError('EMPTY_RESPONSE', 'Gemini 响应没有候选内容', {
            provider: ctx.effective.providerId,
            model: ctx.effective.id,
        });
    }
    finalize(emit, state);
}
export const geminiAdapter = {
    async run(ctx, emit) {
        const { effective, request, stream } = ctx;
        if (rejectsStreamingFunctionArgs(effective, request)) {
            throw new LLMError('UNSUPPORTED_FEATURE', 'Gemini streamFunctionCallArguments（partialArgs）尚未支持', {
                provider: effective.providerId,
                model: effective.id,
            });
        }
        const apiKey = resolveApiKey(effective, ctx.env);
        const headers = buildHeaders(effective, apiKey, request.headers);
        const url = requestUrl(effective, stream);
        const body = request.rawBody ?? buildBody(ctx);
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
            emitJson(ctx, emit, json);
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
            emitJson(ctx, emit, json);
            return;
        }
        const state = emptyState();
        const onEvent = (event) => {
            ctx.onRawEvent?.(event.data);
            if (event.data === '[DONE]')
                return;
            let data;
            try {
                data = JSON.parse(event.data);
            }
            catch {
                return;
            }
            const root = obj(data);
            if (root)
                processRoot(root, emit, state);
        };
        await readSse(handle, { ...spec }, onEvent);
        finalize(emit, state);
    },
};
