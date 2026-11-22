import type { EffectiveModel } from './config.ts';
import type { ChatRequest } from './types.ts';
export declare const CORE_BODY_KEYS: string[];
export declare function isPresent(value: unknown): boolean;
export declare function resolveApiKey(effective: EffectiveModel, env: Record<string, string | undefined> | undefined): string | undefined;
export declare function buildHeaders(effective: EffectiveModel, apiKey: string | undefined, extraHeaders?: Record<string, string>): Record<string, string>;
/** Request keys that are not normalized: forwarded verbatim. */
export declare function passthrough(request: ChatRequest): Record<string, unknown>;
/**
 * Merge order: static extraBody -> protocol core body -> request passthrough -> request.extra.
 * A request value always wins over a static default; core keys can only be written by the library.
 */
export declare function mergeBody(effective: EffectiveModel, request: ChatRequest, core: Record<string, unknown>): Record<string, unknown>;
export declare function maxTokensValue(effective: EffectiveModel, request: ChatRequest): number | undefined;
export declare function maxTokensField(effective: EffectiveModel): string;
export declare function samplingBody(effective: EffectiveModel, request: ChatRequest): Record<string, unknown>;
export declare function applyThinking(effective: EffectiveModel, request: ChatRequest, target: 'openai-chat-completions' | 'anthropic-messages'): {
    openai?: Record<string, unknown>;
    anthropic?: Record<string, unknown>;
};
