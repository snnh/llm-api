import { LLMError } from "./errors.js";
export const CORE_BODY_KEYS = ['model', 'messages', 'stream', 'tools', 'system', 'input'];
const NORMALIZED_KEYS = new Set([
    'model', 'provider', 'system', 'systemSuffix', 'messages', 'tools', 'deferredTools', 'thinking', 'effort',
    'thinkingBudgetTokens', 'configurationUpdates', 'maxTokens', 'temperature', 'topP', 'topK', 'stop', 'seed', 'jsonMode',
    'cacheBreakpoints', 'promptCacheOptions', 'promptCacheKey', 'serverWebSearch', 'headers', 'rawBody', 'extra', 'signal',
]);
export function isPresent(value) {
    if (value === undefined || value === null)
        return false;
    if (Array.isArray(value) && value.length === 0)
        return false;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
        return false;
    return true;
}
export function resolveApiKey(effective, env) {
    if (effective.apiKey)
        return effective.apiKey;
    const reference = effective.auth.env ?? effective.apiKeyEnv;
    if (!reference)
        return undefined;
    const value = env ? env[reference] : process.env[reference];
    if (!value) {
        throw new LLMError('MISSING_CREDENTIAL', `凭据 ${reference} 未解析到值`, {
            provider: effective.providerId,
            model: effective.id,
        });
    }
    return value;
}
export function buildHeaders(effective, apiKey, extraHeaders) {
    const headers = { 'content-type': 'application/json', ...effective.headers };
    if (effective.interfaceType === 'anthropic-messages' && !hasHeader(headers, 'anthropic-version')) {
        headers['anthropic-version'] = '2023-06-01';
    }
    if (apiKey) {
        const { header, scheme } = effective.auth;
        headers[header] = scheme ? `${scheme} ${apiKey}` : apiKey;
    }
    if (extraHeaders) {
        for (const [key, value] of Object.entries(extraHeaders))
            headers[key] = value;
    }
    return headers;
}
function hasHeader(headers, name) {
    return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}
/** Request keys that are not normalized: forwarded verbatim. */
export function passthrough(request) {
    const out = {};
    for (const [key, value] of Object.entries(request)) {
        if (NORMALIZED_KEYS.has(key))
            continue;
        if (!isPresent(value))
            continue;
        out[key] = value;
    }
    return out;
}
/**
 * Merge order: static extraBody -> protocol core body -> request passthrough -> request.extra.
 * A request value always wins over a static default; core keys can only be written by the library.
 */
export function mergeBody(effective, request, core) {
    const body = {};
    for (const [key, value] of Object.entries(effective.extraBody)) {
        if (CORE_BODY_KEYS.includes(key))
            continue;
        if (!isPresent(value))
            continue;
        body[key] = value;
    }
    Object.assign(body, core);
    for (const [key, value] of Object.entries(passthrough(request))) {
        if (CORE_BODY_KEYS.includes(key))
            continue;
        body[key] = value;
    }
    for (const [key, value] of Object.entries(request.extra ?? {})) {
        if (CORE_BODY_KEYS.includes(key))
            continue;
        if (!isPresent(value))
            continue;
        body[key] = value;
    }
    return body;
}
export function maxTokensValue(effective, request) {
    const value = request.maxTokens ?? effective.defaults.maxTokens;
    return typeof value === 'number' ? value : undefined;
}
export function maxTokensField(effective) {
    return effective.compat.maxTokensField ?? effective.fieldMap.maxTokens ?? 'max_tokens';
}
export function samplingBody(effective, request) {
    const body = {};
    const temperature = request.temperature ?? effective.defaults.temperature;
    const topP = request.topP ?? effective.defaults.topP;
    const topK = request.topK ?? effective.defaults.topK;
    if (isPresent(temperature))
        body.temperature = temperature;
    if (isPresent(topP))
        body[effective.fieldMap.topP ?? 'top_p'] = topP;
    if (isPresent(topK))
        body[effective.fieldMap.topK ?? 'top_k'] = topK;
    if (isPresent(request.stop))
        body.stop = request.stop;
    if (isPresent(request.seed))
        body.seed = request.seed;
    if (request.jsonMode === true)
        body.response_format = { type: 'json_object' };
    return body;
}
export function applyThinking(effective, request, target) {
    const style = effective.capabilities.thinkingStyle;
    if (!style)
        return {};
    if (target === 'openai-chat-completions') {
        switch (style) {
            case 'thinking': {
                const out = {};
                if (request.thinking)
                    out.thinking = { type: request.thinking === 'disabled' ? 'disabled' : 'enabled' };
                if (isPresent(request.effort))
                    out.reasoning_effort = request.effort;
                return { openai: out };
            }
            case 'enable_thinking':
                if (request.thinking)
                    return { openai: { enable_thinking: request.thinking !== 'disabled' } };
                return {};
            case 'effort_only':
                if (isPresent(request.effort))
                    return { openai: { reasoning_effort: request.effort } };
                return {};
            case 'fixed': {
                const out = {};
                if (request.thinking)
                    out.thinking = { type: 'enabled' };
                if (isPresent(request.effort))
                    out.reasoning_effort = request.effort;
                return { openai: out };
            }
            default:
                return {};
        }
    }
    switch (style) {
        case 'thinking':
            if (request.thinking)
                return { anthropic: { thinking: { type: request.thinking === 'disabled' ? 'disabled' : 'enabled' } } };
            return {};
        case 'extended':
            if (request.thinking !== 'disabled') {
                const thinking = { type: 'enabled' };
                if (typeof request.thinkingBudgetTokens === 'number')
                    thinking.budget_tokens = request.thinkingBudgetTokens;
                return { anthropic: { thinking } };
            }
            return { anthropic: { thinking: { type: 'disabled' } } };
        case 'adaptive':
            return { anthropic: { thinking: { type: 'adaptive' } } };
        case 'fixed':
            return { anthropic: { thinking: { type: 'enabled' } } };
        default:
            return {};
    }
}
