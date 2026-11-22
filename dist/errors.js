export class LLMError extends Error {
    code;
    status;
    provider;
    model;
    retryAfterMs;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'LLMError';
        this.code = code;
        if (options.status !== undefined)
            this.status = options.status;
        if (options.provider !== undefined)
            this.provider = options.provider;
        if (options.model !== undefined)
            this.model = options.model;
        if (options.retryAfterMs !== undefined)
            this.retryAfterMs = options.retryAfterMs;
    }
}
export function isLLMError(value) {
    return value instanceof LLMError;
}
