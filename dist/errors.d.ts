export type ErrorCode = 'MISSING_CREDENTIAL' | 'INVALID_REQUEST' | 'QUOTA' | 'CONTEXT_WINDOW_EXCEEDED' | 'TRANSPORT' | 'EMPTY_RESPONSE' | 'INVALID_CONFIG' | 'UNSUPPORTED_FEATURE' | 'ABORTED' | 'UNKNOWN_MODEL';
export interface LLMErrorOptions {
    status?: number;
    provider?: string;
    model?: string;
    retryAfterMs?: number;
    cause?: unknown;
}
export declare class LLMError extends Error {
    readonly code: ErrorCode;
    readonly status?: number;
    readonly provider?: string;
    readonly model?: string;
    readonly retryAfterMs?: number;
    constructor(code: ErrorCode, message: string, options?: LLMErrorOptions);
}
export declare function isLLMError(value: unknown): value is LLMError;
