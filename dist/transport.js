import { createParser } from 'eventsource-parser';
import { LLMError } from "./errors.js";
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(abortedError(signal));
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortedError(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function abortedError(signal) {
    const reason = signal?.reason;
    return new LLMError('ABORTED', reason instanceof Error ? reason.message : '请求已取消');
}
function retryAfterMs(res) {
    const header = res.headers.get('retry-after');
    if (!header)
        return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds))
        return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date))
        return Math.max(0, date - Date.now());
    return undefined;
}
function backoffMs(attempt) {
    return Math.min(8_000, 250 * 2 ** attempt);
}
function errorMessageFromBody(text) {
    try {
        const parsed = JSON.parse(text);
        const error = parsed.error;
        if (typeof error === 'string')
            return error;
        if (error && typeof error === 'object') {
            const message = error.message;
            if (typeof message === 'string')
                return message;
        }
        if (typeof parsed.message === 'string')
            return parsed.message;
        if (typeof parsed.detail === 'string')
            return parsed.detail;
    }
    catch {
        // not JSON
    }
    return undefined;
}
export function classifyStatus(status, body, spec) {
    const mapped = spec.errors?.[String(status)];
    const message = errorMessageFromBody(body) ?? body.slice(0, 300) ?? `HTTP ${status}`;
    const contextHint = /context.{0,20}(length|window)|maximum context|too many tokens|context_length_exceeded/i.test(body);
    let code;
    if (mapped)
        code = mapped;
    else if (status === 401 || status === 403)
        code = 'MISSING_CREDENTIAL';
    else if (status === 429)
        code = 'QUOTA';
    else if (status === 400 && contextHint)
        code = 'CONTEXT_WINDOW_EXCEEDED';
    else if (status >= 400 && status < 500)
        code = 'INVALID_REQUEST';
    else
        code = 'TRANSPORT';
    return new LLMError(code, message, {
        status,
        ...(spec.provider ? { provider: spec.provider } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.retryAfterMs !== undefined ? { retryAfterMs: spec.retryAfterMs } : {}),
    });
}
async function fetchOnce(spec, extraSignals = []) {
    const connect = new AbortController();
    const signals = [
        ...(spec.signal ? [spec.signal] : []),
        connect.signal,
        ...extraSignals,
    ];
    const combined = AbortSignal.any(signals);
    const timer = setTimeout(() => connect.abort(new Error('connect timeout')), spec.connectTimeoutMs);
    try {
        return await (spec.fetch ?? fetch)(spec.url, {
            method: spec.method ?? 'POST',
            headers: spec.headers,
            ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
            signal: combined,
        });
    }
    catch (cause) {
        if (spec.signal?.aborted)
            throw abortedError(spec.signal);
        if (cause instanceof Error && cause.name === 'AbortError') {
            throw new LLMError('TRANSPORT', `连接超时（${spec.connectTimeoutMs}ms）`, {
                ...(spec.provider ? { provider: spec.provider } : {}),
                ...(spec.model ? { model: spec.model } : {}),
                cause,
            });
        }
        throw new LLMError('TRANSPORT', cause instanceof Error ? cause.message : '网络请求失败', {
            ...(spec.provider ? { provider: spec.provider } : {}),
            ...(spec.model ? { model: spec.model } : {}),
            cause,
        });
    }
    finally {
        clearTimeout(timer);
    }
}
async function open(spec, readBody, extraSignals = []) {
    let attempt = 0;
    for (;;) {
        const res = await fetchOnce(spec, extraSignals);
        if (res.ok)
            return res;
        const retryable = spec.retry.statuses.includes(res.status) && attempt < spec.retry.maxAttempts;
        if (retryable) {
            const wait = retryAfterMs(res) ?? backoffMs(attempt);
            await res.body?.cancel().catch(() => { });
            await sleep(wait, spec.signal);
            attempt += 1;
            continue;
        }
        const text = readBody ? await res.text().catch(() => '') : '';
        throw classifyStatus(res.status, text, { ...spec, retryAfterMs: retryAfterMs(res) });
    }
}
export async function requestJson(spec) {
    const res = await open(spec, true);
    const text = await res.text();
    let json;
    try {
        json = text.length ? JSON.parse(text) : undefined;
    }
    catch (cause) {
        throw new LLMError('TRANSPORT', '响应不是 JSON', { ...spec, cause });
    }
    return { status: res.status, text, json };
}
export async function openStream(spec) {
    const local = new AbortController();
    const response = await open(spec, true, [local.signal]);
    let idleTimer;
    const arm = () => {
        if (spec.streamIdleTimeoutMs <= 0)
            return;
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(() => local.abort(new Error('stream idle timeout')), spec.streamIdleTimeoutMs);
        idleTimer.unref?.();
    };
    arm();
    return {
        response,
        touch: arm,
        close: () => {
            if (idleTimer)
                clearTimeout(idleTimer);
            local.abort();
        },
    };
}
const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;
export async function readSse(handle, spec, onEvent) {
    const body = handle.response.body;
    if (!body)
        throw new LLMError('TRANSPORT', '响应没有可读的流', { ...spec });
    const maxEventBytes = spec.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    const parser = createParser({
        onEvent: (event) => {
            // Only data events reset the watchdog: proxy heartbeat comments must not
            // keep a half-open stream alive.
            handle.touch();
            if (Buffer.byteLength(event.data, 'utf8') > maxEventBytes) {
                throw new LLMError('TRANSPORT', `SSE 事件超过 ${maxEventBytes} 字节上限`, {
                    ...(spec.provider ? { provider: spec.provider } : {}),
                    ...(spec.model ? { model: spec.model } : {}),
                });
            }
            void onEvent({ ...(event.event ? { event: event.event } : {}), data: event.data });
        },
    });
    const decoder = new TextDecoder();
    try {
        for await (const chunk of body) {
            parser.feed(decoder.decode(chunk, { stream: true }));
        }
        parser.feed(decoder.decode());
        parser.reset({ consume: true });
    }
    catch (cause) {
        if (spec.signal?.aborted)
            throw abortedError(spec.signal);
        if (cause instanceof LLMError)
            throw cause;
        throw new LLMError('TRANSPORT', cause instanceof Error ? cause.message : '流中断', {
            ...(spec.provider ? { provider: spec.provider } : {}),
            ...(spec.model ? { model: spec.model } : {}),
            cause,
        });
    }
    finally {
        handle.close();
    }
}
