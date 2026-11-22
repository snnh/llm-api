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

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };

export function joinUrl(baseUrl: string, path: string | undefined, fallback: string, query?: Record<string, string>): string {
  let url = baseUrl.replace(/\/+$/, '');
  const suffix = path ?? fallback;
  if (!suffix.startsWith('/')) url += '/';
  url += suffix;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(query);
    url += `${url.includes('?') ? '&' : '?'}${params.toString()}`;
  }
  return url;
}

export function mapStopReason(reason: string | null | undefined): StopReason {
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

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
