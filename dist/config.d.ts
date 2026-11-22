import { z } from 'zod';
import type { Capabilities, CreateOptions, Diagnostic, FamilyConfig, InterfaceType, LLMConfig, ModelConfig, ModelView, ProviderConfig, ProviderView } from './types.ts';
export declare const llmConfigSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    force: z.ZodOptional<z.ZodBoolean>;
    defaults: z.ZodOptional<z.ZodObject<{
        caching: z.ZodOptional<z.ZodEnum<{
            explicit: "explicit";
            auto: "auto";
            none: "none";
        }>>;
        connectTimeoutMs: z.ZodOptional<z.ZodNumber>;
        streamIdleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodOptional<z.ZodObject<{
            maxAttempts: z.ZodOptional<z.ZodNumber>;
            statuses: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    providers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        enabled: z.ZodOptional<z.ZodBoolean>;
        force: z.ZodOptional<z.ZodBoolean>;
        interfaceType: z.ZodEnum<{
            "openai-chat-completions": "openai-chat-completions";
            "anthropic-messages": "anthropic-messages";
            "openai-responses": "openai-responses";
        }>;
        displayName: z.ZodOptional<z.ZodString>;
        baseUrl: z.ZodOptional<z.ZodString>;
        path: z.ZodOptional<z.ZodString>;
        query: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        auth: z.ZodOptional<z.ZodObject<{
            header: z.ZodOptional<z.ZodString>;
            scheme: z.ZodOptional<z.ZodString>;
            env: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        apiKey: z.ZodOptional<z.ZodString>;
        apiKeyEnv: z.ZodOptional<z.ZodString>;
        caching: z.ZodOptional<z.ZodEnum<{
            explicit: "explicit";
            auto: "auto";
            none: "none";
        }>>;
        includeUsage: z.ZodOptional<z.ZodBoolean>;
        extraBody: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        toolFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        messageFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        fieldMap: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        family: z.ZodOptional<z.ZodString>;
        maxConcurrent: z.ZodOptional<z.ZodNumber>;
        streamIdleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        connectTimeoutMs: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodOptional<z.ZodObject<{
            maxAttempts: z.ZodOptional<z.ZodNumber>;
            statuses: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
        }, z.core.$loose>>;
        discover: z.ZodOptional<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
            readPath: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        embed: z.ZodOptional<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
            readPath: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        rerank: z.ZodOptional<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
            readPath: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        image: z.ZodOptional<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
            readPath: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        errors: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        compat: z.ZodOptional<z.ZodObject<{
            systemPrompt: z.ZodOptional<z.ZodEnum<{
                field: "field";
                message: "message";
            }>>;
            maxTokensField: z.ZodOptional<z.ZodString>;
            omitMaxTokens: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    families: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        force: z.ZodOptional<z.ZodBoolean>;
        match: z.ZodOptional<z.ZodArray<z.ZodString>>;
        provider: z.ZodOptional<z.ZodString>;
        interfaceType: z.ZodOptional<z.ZodEnum<{
            "openai-chat-completions": "openai-chat-completions";
            "anthropic-messages": "anthropic-messages";
            "openai-responses": "openai-responses";
        }>>;
        baseUrl: z.ZodOptional<z.ZodString>;
        contextWindow: z.ZodOptional<z.ZodNumber>;
        maxOutput: z.ZodOptional<z.ZodNumber>;
        defaults: z.ZodOptional<z.ZodObject<{
            temperature: z.ZodOptional<z.ZodNumber>;
            topP: z.ZodOptional<z.ZodNumber>;
            topK: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        capabilities: z.ZodOptional<z.ZodObject<{
            modalities: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                text: "text";
                image: "image";
                video: "video";
            }>>>;
            tools: z.ZodOptional<z.ZodBoolean>;
            effort: z.ZodOptional<z.ZodUnion<[z.ZodArray<z.ZodString>, z.ZodLiteral<false>]>>;
            unsupportedParams: z.ZodOptional<z.ZodArray<z.ZodString>>;
            thinking: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                enabled: "enabled";
                disabled: "disabled";
                adaptive: "adaptive";
            }>>>;
            thinkingStyle: z.ZodOptional<z.ZodEnum<{
                adaptive: "adaptive";
                thinking: "thinking";
                enable_thinking: "enable_thinking";
                effort_only: "effort_only";
                fixed: "fixed";
                extended: "extended";
            }>>;
            reasoningContent: z.ZodOptional<z.ZodBoolean>;
            outputConfigEffort: z.ZodOptional<z.ZodBoolean>;
            responsesEncryptedReplay: z.ZodOptional<z.ZodBoolean>;
            deferLoading: z.ZodOptional<z.ZodBoolean>;
            parallelToolCalls: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>>;
        caching: z.ZodOptional<z.ZodEnum<{
            explicit: "explicit";
            auto: "auto";
            none: "none";
        }>>;
        extraBody: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        toolFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        messageFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        fieldMap: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        compat: z.ZodOptional<z.ZodObject<{
            systemPrompt: z.ZodOptional<z.ZodEnum<{
                field: "field";
                message: "message";
            }>>;
            maxTokensField: z.ZodOptional<z.ZodString>;
            omitMaxTokens: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>>;
    }, z.core.$loose>>>;
    models: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        force: z.ZodOptional<z.ZodBoolean>;
        aliases: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        provider: z.ZodOptional<z.ZodString>;
        family: z.ZodOptional<z.ZodString>;
        upstream: z.ZodOptional<z.ZodString>;
        interfaceType: z.ZodOptional<z.ZodEnum<{
            "openai-chat-completions": "openai-chat-completions";
            "anthropic-messages": "anthropic-messages";
            "openai-responses": "openai-responses";
        }>>;
        baseUrl: z.ZodOptional<z.ZodString>;
        contextWindow: z.ZodOptional<z.ZodNumber>;
        maxOutput: z.ZodOptional<z.ZodNumber>;
        defaults: z.ZodOptional<z.ZodObject<{
            temperature: z.ZodOptional<z.ZodNumber>;
            topP: z.ZodOptional<z.ZodNumber>;
            topK: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        capabilities: z.ZodOptional<z.ZodObject<{
            modalities: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                text: "text";
                image: "image";
                video: "video";
            }>>>;
            tools: z.ZodOptional<z.ZodBoolean>;
            effort: z.ZodOptional<z.ZodUnion<[z.ZodArray<z.ZodString>, z.ZodLiteral<false>]>>;
            unsupportedParams: z.ZodOptional<z.ZodArray<z.ZodString>>;
            thinking: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                enabled: "enabled";
                disabled: "disabled";
                adaptive: "adaptive";
            }>>>;
            thinkingStyle: z.ZodOptional<z.ZodEnum<{
                adaptive: "adaptive";
                thinking: "thinking";
                enable_thinking: "enable_thinking";
                effort_only: "effort_only";
                fixed: "fixed";
                extended: "extended";
            }>>;
            reasoningContent: z.ZodOptional<z.ZodBoolean>;
            outputConfigEffort: z.ZodOptional<z.ZodBoolean>;
            responsesEncryptedReplay: z.ZodOptional<z.ZodBoolean>;
            deferLoading: z.ZodOptional<z.ZodBoolean>;
            parallelToolCalls: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>>;
        caching: z.ZodOptional<z.ZodEnum<{
            explicit: "explicit";
            auto: "auto";
            none: "none";
        }>>;
        extraBody: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        toolFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        messageFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        fieldMap: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        compat: z.ZodOptional<z.ZodObject<{
            systemPrompt: z.ZodOptional<z.ZodEnum<{
                field: "field";
                message: "message";
            }>>;
            maxTokensField: z.ZodOptional<z.ZodString>;
            omitMaxTokens: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>>;
    }, z.core.$loose>>>;
}, z.core.$loose>;
export declare function configJsonSchema(): unknown;
export interface ParsedConfig {
    config?: LLMConfig;
    diagnostics: Diagnostic[];
}
export declare function parseConfig(input: unknown, opts?: CreateOptions): ParsedConfig;
export declare function loadConfig(path: string, opts?: CreateOptions): LLMConfig;
export declare function saveConfigFile(path: string, raw: LLMConfig): void;
export interface EffectiveModel {
    id: string;
    upstream: string;
    provider: ProviderConfig;
    providerId: string;
    force: boolean;
    interfaceType: InterfaceType;
    baseUrl: string;
    path?: string;
    query?: Record<string, string>;
    headers: Record<string, string>;
    auth: {
        header: string;
        scheme: string;
        env?: string;
    };
    apiKey?: string;
    apiKeyEnv?: string;
    caching: 'explicit' | 'auto' | 'none';
    includeUsage: boolean;
    extraBody: Record<string, unknown>;
    toolFields: Record<string, unknown>;
    messageFields: Record<string, unknown>;
    fieldMap: Record<string, string>;
    compat: {
        systemPrompt: 'field' | 'message';
        maxTokensField?: string;
        omitMaxTokens?: boolean;
    };
    contextWindow: number;
    maxOutput: number;
    defaults: Required<Pick<import('./types.ts').Defaults, 'temperature' | 'topP' | 'topK' | 'maxTokens'>> & import('./types.ts').Defaults;
    capabilities: Capabilities;
    connectTimeoutMs: number;
    streamIdleTimeoutMs: number;
    retry: {
        maxAttempts: number;
        statuses: number[];
    };
    discover?: {
        path?: string;
        readPath?: string;
    };
    errors: Record<string, string>;
    family?: FamilyConfig;
    model?: ModelConfig;
    source: 'model' | 'family' | 'provider';
    state: 'ok' | 'error';
    diagnostics: Diagnostic[];
}
export declare class ConfigState {
    readonly raw: LLMConfig;
    readonly diagnostics: Diagnostic[];
    readonly globalDiagnostics: Diagnostic[];
    private readonly opts;
    constructor(raw: LLMConfig, opts?: CreateOptions);
    private inspectGlobal;
    providers(): ProviderConfig[];
    providerViews(): ProviderView[];
    private familyIndex;
    private familiesFor;
    private singleProvider;
    resolve(idOrAddress: string, providerHint?: string): EffectiveModel;
    private buildEffective;
    private entryPath;
    views(): ModelView[];
    modelView(id: string, provider?: string): ModelView | undefined;
    describe(): unknown;
}
export declare function redact(value: unknown): unknown;
