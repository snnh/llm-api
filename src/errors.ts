export type ErrorCode =
  | 'MISSING_CREDENTIAL'
  | 'INVALID_REQUEST'
  | 'QUOTA'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'TRANSPORT'
  | 'EMPTY_RESPONSE'
  | 'INVALID_CONFIG'
  | 'UNSUPPORTED_FEATURE'
  | 'ABORTED'
  | 'UNKNOWN_MODEL';

export interface LLMErrorOptions {
  status?: number;
  provider?: string;
  model?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class LLMError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, message: string, options: LLMErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LLMError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.model !== undefined) this.model = options.model;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function isLLMError(value: unknown): value is LLMError {
  return value instanceof LLMError;
}
