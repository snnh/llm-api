/** Minimal path reader: supports `$.a.b`, arrays by index, and `[*]` expansion. */
export declare function selectPath(root: unknown, expression: string): unknown[];
export declare function selectOne(root: unknown, expression: string): unknown;
/** Like selectPath, but unwraps a single array result so `$.results` and `$.data[*]` both work. */
export declare function selectArray(root: unknown, expression: string): unknown[];
