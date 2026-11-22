import { type Adapter } from './adapter.ts';
/** OpenAI Responses rejects max_output_tokens values below 16. */
export declare const MIN_OUTPUT_TOKENS = 16;
export declare const responsesAdapter: Adapter;
