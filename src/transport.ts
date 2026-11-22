import { createParser } from 'eventsource-parser';
import { LLMError } from './errors.ts';
import type { ErrorCode } from './errors.ts';

export interface TransportConfig {
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
  retry: { maxAttempts: number; statuses: number[] };
  provider?: string;
  model?: string;
  errors?: Record<string, string>;
  /** Upper bound for a single SSE data payload. Defaults to 8 MiB. */
  maxEventBytes?: number;
}

export interface RequestSpec extends TransportConfig {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Optional fetch override; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError(signal));
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

function abortedError(signal?: AbortSignal): LLMError {
  const reason = signal?.reason;
  return new LLMError('ABORTED', reason instanceof Error ? reason.message : '请求已取消');
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 250 * 2 ** attempt);
}

function errorMessageFromBody(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    // not JSON
  }
  return undefined;
}

export function classifyStatus(
  status: number,
  body: string,
  spec: { provider?: string; model?: string; errors?: Record<string, string>; retryAfterMs?: number },
): LLMError {
  const mapped = spec.errors?.[String(status)];
  const message = errorMessageFromBody(body) ?? body.slice(0, 300) ?? `HTTP ${status}`;
  const contextHint = /context.{0,20}(length|window)|maximum context|too many tokens|context_length_exceeded/i.test(body);
  let code: ErrorCode;
  if (mapped) code = mapped as ErrorCode;
  else if (status === 401 || status === 403) code = 'MISSING_CREDENTIAL';
  else if (status === 429) code = 'QUOTA';
  else if (status === 400 && contextHint) code = 'CONTEXT_WINDOW_EXCEEDED';
  else if (status >= 400 && status < 500) code = 'INVALID_REQUEST';
  else code = 'TRANSPORT';
  return new LLMError(code, message, {
    status,
    ...(spec.provider ? { provider: spec.provider } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.retryAfterMs !== undefined ? { retryAfterMs: spec.retryAfterMs } : {}),
  });
}

async function fetchOnce(spec: RequestSpec, extraSignals: AbortSignal[] = []): Promise<Response> {
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
  } catch (cause) {
    if (spec.signal?.aborted) throw abortedError(spec.signal);
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
  } finally {
    clearTimeout(timer);
  }
}

async function open(spec: RequestSpec, readBody: boolean, extraSignals: AbortSignal[] = []): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const res = await fetchOnce(spec, extraSignals);
    if (res.ok) return res;
    const retryable = spec.retry.statuses.includes(res.status) && attempt < spec.retry.maxAttempts;
    if (retryable) {
      const wait = retryAfterMs(res) ?? backoffMs(attempt);
      await res.body?.cancel().catch(() => {});
      await sleep(wait, spec.signal);
      attempt += 1;
      continue;
    }
    const text = readBody ? await res.text().catch(() => '') : '';
    throw classifyStatus(res.status, text, { ...spec, retryAfterMs: retryAfterMs(res) });
  }
}

export async function requestJson(spec: RequestSpec): Promise<{ status: number; text: string; json: unknown }> {
  const res = await open(spec, true);
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length ? JSON.parse(text) : undefined;
  } catch (cause) {
    throw new LLMError('TRANSPORT', '响应不是 JSON', { ...spec, cause });
  }
  return { status: res.status, text, json };
}

export interface StreamHandle {
  response: Response;
  /** Reset the idle watchdog after each received chunk. */
  touch(): void;
  /** Release the watchdog and abort the request. */
  close(): void;
}

export async function openStream(spec: RequestSpec): Promise<StreamHandle> {
  const local = new AbortController();
  const response = await open(spec, true, [local.signal]);
  let idleTimer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (spec.streamIdleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => local.abort(new Error('stream idle timeout')), spec.streamIdleTimeoutMs);
    idleTimer.unref?.();
  };
  arm();
  return {
    response,
    touch: arm,
    close: () => {
      if (idleTimer) clearTimeout(idleTimer);
      local.abort();
    },
  };
}

export interface RawEvent {
  event?: string;
  data: string;
}

const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;

export async function readSse(
  handle: StreamHandle,
  spec: RequestSpec,
  onEvent: (event: RawEvent) => void | Promise<void>,
): Promise<void> {
  const body = handle.response.body;
  if (!body) throw new LLMError('TRANSPORT', '响应没有可读的流', { ...spec });
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
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      parser.feed(decoder.decode(chunk, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.reset({ consume: true });
  } catch (cause) {
    if (spec.signal?.aborted) throw abortedError(spec.signal);
    if (cause instanceof LLMError) throw cause;
    throw new LLMError('TRANSPORT', cause instanceof Error ? cause.message : '流中断', {
      ...(spec.provider ? { provider: spec.provider } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      cause,
    });
  } finally {
    handle.close();
  }
}
