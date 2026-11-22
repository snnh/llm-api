import type { EffectiveModel } from './config.ts';
import type { ChatRequest, LLMEvent, StopReason, Usage } from './types.ts';
export interface AdapterContext {
    effective: EffectiveModel;
    request: ChatRequest;
    stream: boolean;
    env?: Record<string, string | undefined> | undefined;
    fetch?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
    onRawEvent?: ((raw: string) => void) | undefined;
}
export type Emit = (event: LLMEvent) => void;
export interface Adapter {
    run(ctx: AdapterContext, emit: Emit): Promise<void>;
}
export declare const EMPTY_USAGE: Usage;
export declare function joinUrl(baseUrl: string, path: string | undefined, fallback: string, query?: Record<string, string>): string;
export declare function mapStopReason(reason: string | null | undefined): StopReason;
export declare function str(value: unknown): string | undefined;
export declare function num(value: unknown): number | undefined;
export declare function obj(value: unknown): Record<string, unknown> | undefined;
export declare function parseJson(text: string): unknown;
