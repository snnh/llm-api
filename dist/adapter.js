export const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
export function joinUrl(baseUrl, path, fallback, query) {
    let url = baseUrl.replace(/\/+$/, '');
    const suffix = path ?? fallback;
    if (!suffix.startsWith('/'))
        url += '/';
    url += suffix;
    if (query && Object.keys(query).length > 0) {
        const params = new URLSearchParams(query);
        url += `${url.includes('?') ? '&' : '?'}${params.toString()}`;
    }
    return url;
}
export function mapStopReason(reason) {
    switch (reason) {
        case 'stop':
        case 'end_turn':
        case 'stop_sequence':
            return 'end_turn';
        case 'length':
        case 'max_tokens':
            return 'max_tokens';
        case 'tool_calls':
        case 'function_call':
        case 'tool_use':
            return 'tool_use';
        case 'content_filter':
        case 'refusal':
            return 'refusal';
        default:
            return reason ? 'error' : 'end_turn';
    }
}
export function str(value) {
    return typeof value === 'string' ? value : undefined;
}
export function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function obj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
export function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
