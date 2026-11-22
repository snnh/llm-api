import { LLMError } from './errors.ts';
export interface TransportConfig {
    connectTimeoutMs: number;
    streamIdleTimeoutMs: number;
    retry: {
        maxAttempts: number;
        statuses: number[];
    };
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
export declare function classifyStatus(status: number, body: string, spec: {
    provider?: string;
    model?: string;
    errors?: Record<string, string>;
    retryAfterMs?: number;
}): LLMError;
export declare function requestJson(spec: RequestSpec): Promise<{
    status: number;
    text: string;
    json: unknown;
}>;
export interface StreamHandle {
    response: Response;
    /** Reset the idle watchdog after each received chunk. */
    touch(): void;
    /** Release the watchdog and abort the request. */
    close(): void;
}
export declare function openStream(spec: RequestSpec): Promise<StreamHandle>;
export interface RawEvent {
    event?: string;
    data: string;
}
export declare function readSse(handle: StreamHandle, spec: RequestSpec, onEvent: (event: RawEvent) => void | Promise<void>): Promise<void>;
