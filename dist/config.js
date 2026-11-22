import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { LLMError } from "./errors.js";
const require = createRequire(import.meta.url);
/* ------------------------------------------------------------------ schema */
const interfaceType = z.enum(['openai-chat-completions', 'anthropic-messages', 'openai-responses']);
const caching = z.enum(['explicit', 'auto', 'none']);
const thinkingStyle = z.enum(['thinking', 'enable_thinking', 'effort_only', 'fixed', 'extended', 'adaptive']);
const stringMap = z.record(z.string(), z.unknown());
const capabilities = z
    .object({
    modalities: z.array(z.enum(['text', 'image', 'video'])).optional(),
    tools: z.boolean().optional(),
    effort: z.array(z.string()).or(z.literal(false)).optional(),
    unsupportedParams: z.array(z.string()).optional(),
    thinking: z.array(z.enum(['enabled', 'disabled', 'adaptive'])).optional(),
    thinkingStyle: thinkingStyle.optional(),
    reasoningContent: z.boolean().optional(),
    outputConfigEffort: z.boolean().optional(),
    responsesEncryptedReplay: z.boolean().optional(),
    deferLoading: z.boolean().optional(),
    parallelToolCalls: z.boolean().optional(),
})
    .loose();
const defaults = z
    .object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
})
    .loose();
const compat = z
    .object({
    systemPrompt: z.enum(['field', 'message']).optional(),
    maxTokensField: z.string().optional(),
    omitMaxTokens: z.boolean().optional(),
})
    .loose();
const retry = z
    .object({ maxAttempts: z.number().int().min(0).optional(), statuses: z.array(z.number().int()).optional() })
    .loose();
const auth = z
    .object({ header: z.string().optional(), scheme: z.string().optional(), env: z.string().optional() })
    .loose();
const discover = z.object({ path: z.string().optional(), readPath: z.string().optional() }).loose();
const endpointMapping = z.object({ path: z.string().optional(), readPath: z.string().optional() }).loose();
const provider = z
    .object({
    id: z.string().min(1),
    enabled: z.boolean().optional(),
    force: z.boolean().optional(),
    interfaceType,
    displayName: z.string().optional(),
    baseUrl: z.string().optional(),
    path: z.string().optional(),
    query: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    auth: auth.optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    caching: caching.optional(),
    includeUsage: z.boolean().optional(),
    extraBody: stringMap.optional(),
    toolFields: stringMap.optional(),
    messageFields: stringMap.optional(),
    fieldMap: z.record(z.string(), z.string()).optional(),
    family: z.string().optional(),
    maxConcurrent: z.number().int().positive().optional(),
    streamIdleTimeoutMs: z.number().int().nonnegative().optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
    retry: retry.optional(),
    discover: discover.optional(),
    embed: endpointMapping.optional(),
    rerank: endpointMapping.optional(),
    image: endpointMapping.optional(),
    errors: z.record(z.string(), z.string()).optional(),
    compat: compat.optional(),
})
    .loose();
const family = z
    .object({
    id: z.string().min(1),
    force: z.boolean().optional(),
    match: z.array(z.string()).optional(),
    provider: z.string().optional(),
    interfaceType: interfaceType.optional(),
    baseUrl: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().optional(),
    defaults: defaults.optional(),
    capabilities: capabilities.optional(),
    caching: caching.optional(),
    extraBody: stringMap.optional(),
    toolFields: stringMap.optional(),
    messageFields: stringMap.optional(),
    fieldMap: z.record(z.string(), z.string()).optional(),
    compat: compat.optional(),
})
    .loose();
const model = z
    .object({
    id: z.string().min(1),
    force: z.boolean().optional(),
    aliases: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    family: z.string().optional(),
    upstream: z.string().optional(),
    interfaceType: interfaceType.optional(),
    baseUrl: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().optional(),
    defaults: defaults.optional(),
    capabilities: capabilities.optional(),
    caching: caching.optional(),
    extraBody: stringMap.optional(),
    toolFields: stringMap.optional(),
    messageFields: stringMap.optional(),
    fieldMap: z.record(z.string(), z.string()).optional(),
    compat: compat.optional(),
})
    .loose();
export const llmConfigSchema = z
    .object({
    version: z.literal(1),
    force: z.boolean().optional(),
    defaults: z
        .object({
        caching: caching.optional(),
        connectTimeoutMs: z.number().int().positive().optional(),
        streamIdleTimeoutMs: z.number().int().nonnegative().optional(),
        retry: retry.optional(),
    })
        .loose()
        .optional(),
    providers: z.array(provider).min(1),
    families: z.array(family).optional(),
    models: z.array(model).optional(),
})
    .loose();
export function configJsonSchema() {
    return z.toJSONSchema(llmConfigSchema);
}
/* -------------------------------------------------------------- diagnostics */
const KNOWN = {
    root: new Set(['version', 'force', 'defaults', 'providers', 'families', 'models']),
    globalDefaults: new Set(['caching', 'connectTimeoutMs', 'streamIdleTimeoutMs', 'retry']),
    provider: new Set([
        'id', 'enabled', 'force', 'interfaceType', 'displayName', 'baseUrl', 'path', 'query', 'headers', 'auth',
        'apiKey', 'apiKeyEnv', 'caching', 'includeUsage', 'extraBody', 'toolFields', 'messageFields',
        'fieldMap', 'family', 'maxConcurrent', 'streamIdleTimeoutMs', 'connectTimeoutMs', 'retry',
        'discover', 'embed', 'rerank', 'image', 'errors', 'compat',
    ]),
    family: new Set([
        'id', 'force', 'match', 'provider', 'interfaceType', 'baseUrl', 'contextWindow', 'maxOutput', 'defaults',
        'capabilities', 'caching', 'extraBody', 'toolFields', 'messageFields', 'fieldMap', 'compat',
    ]),
    model: new Set([
        'id', 'force', 'aliases', 'enabled', 'provider', 'family', 'upstream', 'interfaceType', 'baseUrl',
        'contextWindow', 'maxOutput', 'defaults', 'capabilities', 'caching', 'extraBody', 'toolFields',
        'messageFields', 'fieldMap', 'compat',
    ]),
    capabilities: new Set([
        'modalities', 'tools', 'effort', 'unsupportedParams', 'thinking', 'thinkingStyle', 'reasoningContent',
        'outputConfigEffort', 'responsesEncryptedReplay', 'deferLoading', 'parallelToolCalls',
    ]),
    defaults: new Set(['temperature', 'topP', 'topK', 'maxTokens']),
    compat: new Set(['systemPrompt', 'maxTokensField', 'omitMaxTokens']),
    retry: new Set(['maxAttempts', 'statuses']),
    auth: new Set(['header', 'scheme', 'env']),
    discover: new Set(['path', 'readPath']),
    endpointMapping: new Set(['path', 'readPath']),
};
function unknownFields(value, kind, path, out) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return;
    const known = KNOWN[kind];
    for (const key of Object.keys(value)) {
        if (!known?.has(key)) {
            out.push({ path: path ? `${path}.${key}` : key, code: 'UNKNOWN_FIELD', severity: 'warning', message: `未知字段 ${key}` });
        }
    }
}
function unknownFieldDiagnostics(raw) {
    const out = [];
    unknownFields(raw, 'root', '', out);
    const providers = Array.isArray(raw.providers) ? raw.providers : [];
    providers.forEach((p, i) => {
        unknownFields(p, 'provider', `providers[${i}]`, out);
        if (p && typeof p === 'object') {
            unknownFields(p.compat, 'compat', `providers[${i}].compat`, out);
            unknownFields(p.retry, 'retry', `providers[${i}].retry`, out);
            unknownFields(p.auth, 'auth', `providers[${i}].auth`, out);
            unknownFields(p.discover, 'discover', `providers[${i}].discover`, out);
        }
    });
    for (const section of ['families', 'models']) {
        const list = Array.isArray(raw[section]) ? raw[section] : [];
        list.forEach((entry, i) => {
            unknownFields(entry, section === 'families' ? 'family' : 'model', `${section}[${i}]`, out);
            if (entry && typeof entry === 'object') {
                const record = entry;
                unknownFields(record.capabilities, 'capabilities', `${section}[${i}].capabilities`, out);
                unknownFields(record.defaults, 'defaults', `${section}[${i}].defaults`, out);
                unknownFields(record.compat, 'compat', `${section}[${i}].compat`, out);
            }
        });
    }
    unknownFields(raw.defaults, 'globalDefaults', 'defaults', out);
    return out;
}
function zodDiagnostics(error) {
    return error.issues.map((issue) => ({
        path: issue.path.length ? issue.path.join('.') : '',
        code: 'INVALID_TYPE',
        severity: 'error',
        message: issue.message,
    }));
}
export function parseConfig(input, opts = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { diagnostics: [{ path: '', code: 'INVALID_TYPE', severity: 'error', message: '配置必须是对象' }] };
    }
    const diagnostics = [];
    const unknown = unknownFieldDiagnostics(input);
    for (const item of unknown) {
        if (opts.strict)
            diagnostics.push({ ...item, severity: 'error' });
        else
            diagnostics.push(item);
    }
    const parsed = llmConfigSchema.safeParse(input);
    if (!parsed.success) {
        diagnostics.push(...zodDiagnostics(parsed.error));
        return { diagnostics };
    }
    if (diagnostics.some((d) => d.severity === 'error'))
        return { diagnostics };
    return { config: parsed.data, diagnostics };
}
/* -------------------------------------------------------------------- load */
export function loadConfig(path, opts = {}) {
    if (!existsSync(path))
        throw new LLMError('INVALID_CONFIG', `配置文件不存在：${path}`);
    const text = readFileSync(path, 'utf8');
    const ext = path.toLowerCase().endsWith('.yaml') || path.toLowerCase().endsWith('.yml') ? 'yaml' : 'json';
    let raw;
    if (ext === 'yaml') {
        try {
            const mod = require('yaml');
            raw = mod.parse(text);
        }
        catch (cause) {
            throw new LLMError('INVALID_CONFIG', `读取 YAML 需要安装可选依赖 yaml：pnpm add yaml`, { cause });
        }
    }
    else {
        try {
            raw = JSON.parse(text);
        }
        catch (cause) {
            throw new LLMError('INVALID_CONFIG', `JSON 解析失败：${path}`, { cause });
        }
    }
    const parsed = parseConfig(raw, { ...opts, source: opts.source ?? path });
    if (!parsed.config) {
        const message = parsed.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.path}: ${d.message}`).join('; ');
        throw new LLMError('INVALID_CONFIG', message || '配置不合法');
    }
    return parsed.config;
}
export function saveConfigFile(path, raw) {
    const ext = path.toLowerCase();
    const text = ext.endsWith('.yaml') || ext.endsWith('.yml') ? yamlStringify(raw) : `${JSON.stringify(raw, null, 2)}\n`;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
}
function yamlStringify(value) {
    const mod = require('yaml');
    return mod.stringify(value, { lineWidth: 0 });
}
const DEFAULT_BASE_URL = {
    'openai-chat-completions': 'https://api.openai.com/v1',
    'anthropic-messages': 'https://api.anthropic.com/v1',
    'openai-responses': 'https://api.openai.com/v1',
};
const DEFAULT_PATH = {
    'openai-chat-completions': '/chat/completions',
    'anthropic-messages': '/messages',
    'openai-responses': '/responses',
};
const DEFAULT_AUTH = {
    'openai-chat-completions': { header: 'authorization', scheme: 'Bearer' },
    'anthropic-messages': { header: 'x-api-key', scheme: '' },
    'openai-responses': { header: 'authorization', scheme: 'Bearer' },
};
const SUPPORTED = ['openai-chat-completions', 'anthropic-messages', 'openai-responses'];
function mergeMaps(...sources) {
    const out = {};
    for (const source of sources) {
        if (!source)
            continue;
        for (const [key, value] of Object.entries(source)) {
            if (value === null)
                delete out[key];
            else
                out[key] = value;
        }
    }
    return out;
}
function mergeDefaults(...sources) {
    return mergeMaps(...sources);
}
function matchLength(family, id) {
    let best = -1;
    for (const pattern of family.match ?? []) {
        let hit = false;
        if (pattern.startsWith('^') || pattern.endsWith('$')) {
            try {
                hit = new RegExp(pattern).test(id);
            }
            catch {
                hit = false;
            }
        }
        else {
            hit = id.startsWith(pattern);
        }
        if (hit)
            best = Math.max(best, pattern.length);
    }
    return best;
}
function matchesFamily(family, id) {
    return matchLength(family, id) >= 0;
}
/** Longest matching pattern wins; equal specificity is ambiguous. */
function bestFamily(families, id) {
    let bestLength = -1;
    let winners = [];
    for (const family of families) {
        const length = matchLength(family, id);
        if (length < 0)
            continue;
        if (length > bestLength) {
            bestLength = length;
            winners = [family];
        }
        else if (length === bestLength) {
            winners.push(family);
        }
    }
    if (winners.length === 1)
        return { family: winners[0], ambiguous: [] };
    return { ambiguous: winners.length > 1 ? winners : [] };
}
export class ConfigState {
    raw;
    diagnostics = [];
    globalDiagnostics = [];
    opts;
    constructor(raw, opts = {}) {
        this.raw = raw;
        this.opts = opts;
        this.globalDiagnostics = this.inspectGlobal();
    }
    inspectGlobal() {
        const out = [];
        const seen = new Set();
        this.raw.providers.forEach((p, i) => {
            if (seen.has(p.id)) {
                out.push({ path: `providers[${i}].id`, code: 'DUPLICATE_ID', severity: 'error', message: `provider id 重复：${p.id}` });
            }
            seen.add(p.id);
            if (p.baseUrl !== undefined && !/^https?:\/\//.test(p.baseUrl)) {
                out.push({ path: `providers[${i}].baseUrl`, code: 'INVALID_URL', severity: 'error', message: 'baseUrl 必须是 http/https URL' });
            }
            if (!SUPPORTED.includes(p.interfaceType)) {
                out.push({ path: `providers[${i}].interfaceType`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: `M1 尚未实现 ${p.interfaceType}` });
            }
            if (p.apiKey !== undefined && p.apiKeyEnv !== undefined) {
                out.push({ path: `providers[${i}]`, code: 'INVALID_VALUE', severity: 'warning', message: 'apiKey 与 apiKeyEnv 同时存在，优先 apiKey' });
            }
            for (const [key, value] of Object.entries(p.extraBody ?? {})) {
                if (['model', 'messages', 'stream', 'tools', 'system'].includes(key)) {
                    out.push({ path: `providers[${i}].extraBody.${key}`, code: 'INVALID_VALUE', severity: 'error', message: `extraBody 不允许覆盖核心字段 ${key}` });
                }
            }
        });
        const familyIds = new Set();
        (this.raw.families ?? []).forEach((f, i) => {
            if (familyIds.has(f.id)) {
                out.push({ path: `families[${i}].id`, code: 'DUPLICATE_ID', severity: 'error', message: `family id 重复：${f.id}` });
            }
            familyIds.add(f.id);
        });
        const modelIds = new Set();
        (this.raw.models ?? []).forEach((m, i) => {
            if (modelIds.has(m.id)) {
                out.push({ path: `models[${i}].id`, code: 'DUPLICATE_ID', severity: 'error', message: `model id 重复：${m.id}` });
            }
            modelIds.add(m.id);
            for (const alias of m.aliases ?? []) {
                if (modelIds.has(alias)) {
                    out.push({ path: `models[${i}].aliases`, code: 'DUPLICATE_ID', severity: 'warning', message: `别名重复：${alias}` });
                }
            }
        });
        return out;
    }
    providers() {
        return this.raw.providers;
    }
    providerViews() {
        return this.raw.providers.map((p, index) => {
            const diagnostics = this.globalDiagnostics.filter((d) => d.path.startsWith(`providers[${index}]`));
            return {
                id: p.id,
                interfaceType: p.interfaceType,
                ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
                enabled: p.enabled !== false,
                ...(p.family ? { family: p.family } : {}),
                state: diagnostics.some((d) => d.severity === 'error') ? 'error' : 'ok',
                diagnostics,
            };
        });
    }
    familyIndex() {
        return this.raw.families ?? [];
    }
    familiesFor(id) {
        return this.familyIndex().filter((f) => matchesFamily(f, id));
    }
    singleProvider() {
        const enabled = this.raw.providers.filter((p) => p.enabled !== false);
        return enabled.length === 1 ? enabled[0] : undefined;
    }
    resolve(idOrAddress, providerHint) {
        let name = idOrAddress;
        let hint = providerHint;
        if (!hint && idOrAddress.includes('/')) {
            const [maybeProvider, ...rest] = idOrAddress.split('/');
            if (this.raw.providers.some((p) => p.id === maybeProvider)) {
                hint = maybeProvider;
                name = rest.join('/');
            }
        }
        const declared = (this.raw.models ?? []).find((m) => m.id === name || (m.aliases ?? []).includes(name));
        const diagnostics = [];
        let family;
        if (declared?.family) {
            family = this.familyIndex().find((f) => f.id === declared.family);
            if (!family)
                diagnostics.push({ path: `models[${declared.id}]`, code: 'NO_MATCH', severity: 'error', message: `family 不存在：${declared.family}` });
        }
        else {
            const picked = bestFamily(this.familyIndex(), declared ? declared.id : name);
            if (picked.ambiguous.length > 0) {
                diagnostics.push({
                    path: `models[${declared?.id ?? name}]`,
                    code: 'AMBIGUOUS_MATCH',
                    severity: 'error',
                    message: `家族匹配歧义（同等具体度）：${picked.ambiguous.map((f) => f.id).join(', ')}`,
                });
            }
            family = picked.family;
        }
        let provider;
        if (hint)
            provider = this.raw.providers.find((p) => p.id === hint);
        if (!provider && declared?.provider)
            provider = this.raw.providers.find((p) => p.id === declared.provider);
        const familyProviderId = family?.provider;
        if (!provider && familyProviderId)
            provider = this.raw.providers.find((p) => p.id === familyProviderId);
        if (!provider && declared && !family)
            provider = this.singleProvider();
        if (!provider && family)
            provider = this.singleProvider();
        if (!provider) {
            const enabled = this.raw.providers.filter((p) => p.enabled !== false);
            if (enabled.length === 1)
                provider = enabled[0];
        }
        if (!provider) {
            diagnostics.push({
                path: `models[${name}]`,
                code: enabledCount(this.raw.providers) > 1 ? 'AMBIGUOUS_MATCH' : 'NO_MATCH',
                severity: 'error',
                message: enabledCount(this.raw.providers) > 1
                    ? `模型 ${name} 无法确定端点，请写成 provider/model 或在请求里指定 provider（候选：${this.raw.providers.map((p) => p.id).join(', ')}）`
                    : `没有可用端点，或模型 ${name} 未命中任何 family.match`,
            });
        }
        if (!declared && !family) {
            const fallback = provider?.family ? this.familyIndex().find((f) => f.id === provider?.family) : undefined;
            if (fallback)
                family = fallback;
            else if (!provider) {
                diagnostics.push({ path: `models[${name}]`, code: 'NO_MATCH', severity: 'error', message: `模型 ${name} 未命中任何家族` });
            }
            else if (!this.familyIndex().some((f) => f.id === 'default')) {
                diagnostics.push({
                    path: `models[${name}]`,
                    code: 'NO_MATCH',
                    severity: 'error',
                    message: `模型 ${name} 未命中任何 family.match，且没有 default 家族`,
                });
            }
        }
        if (!provider) {
            throw new LLMError('UNKNOWN_MODEL', diagnostics.map((d) => d.message).join('; ') || `未知模型：${name}`);
        }
        const effective = this.buildEffective(name, declared, family, provider, diagnostics);
        if (effective.diagnostics.some((d) => d.severity === 'error'))
            effective.state = 'error';
        return effective;
    }
    buildEffective(name, model, family, provider, diagnostics) {
        const interfaceType = model?.interfaceType ?? family?.interfaceType ?? provider.interfaceType;
        const force = model?.force ?? family?.force ?? provider.force ?? this.raw.force ?? false;
        const auth = provider.auth;
        const baseUrl = model?.baseUrl ?? family?.baseUrl ?? provider.baseUrl ?? DEFAULT_BASE_URL[interfaceType];
        const caching = model?.caching ?? family?.caching ?? provider.caching ?? this.raw.defaults?.caching ?? 'auto';
        const compat = {
            systemPrompt: provider.compat?.systemPrompt ?? family?.compat?.systemPrompt ?? model?.compat?.systemPrompt ??
                (interfaceType === 'openai-chat-completions' ? 'message' : 'field'),
            maxTokensField: model?.compat?.maxTokensField ?? family?.compat?.maxTokensField ?? provider.compat?.maxTokensField,
            omitMaxTokens: model?.compat?.omitMaxTokens ?? family?.compat?.omitMaxTokens ?? provider.compat?.omitMaxTokens ?? false,
        };
        const capabilities = mergeMaps(family?.capabilities, model?.capabilities);
        const defaults = mergeDefaults(family?.defaults, model?.defaults);
        const fieldMap = mergeMaps(provider.fieldMap, family?.fieldMap, model?.fieldMap);
        const extraBody = mergeMaps(provider.extraBody, family?.extraBody, model?.extraBody);
        const toolFields = mergeMaps(provider.toolFields, family?.toolFields, model?.toolFields);
        const messageFields = mergeMaps(provider.messageFields, family?.messageFields, model?.messageFields);
        const effective = {
            id: model?.id ?? name,
            upstream: model?.upstream ?? name,
            provider,
            providerId: provider.id,
            force,
            interfaceType,
            baseUrl,
            ...(provider.path ? { path: provider.path } : {}),
            ...(provider.query ? { query: provider.query } : {}),
            headers: { ...(provider.headers ?? {}) },
            auth: {
                header: auth?.header ?? DEFAULT_AUTH[interfaceType].header,
                scheme: auth?.scheme ?? DEFAULT_AUTH[interfaceType].scheme,
                ...(auth?.env ?? provider.apiKeyEnv ? { env: auth?.env ?? provider.apiKeyEnv } : {}),
            },
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
            ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
            caching,
            includeUsage: provider.includeUsage ?? false,
            extraBody: extraBody,
            toolFields: toolFields,
            messageFields: messageFields,
            fieldMap,
            compat,
            contextWindow: model?.contextWindow ?? family?.contextWindow ?? 256_000,
            maxOutput: model?.maxOutput ?? family?.maxOutput ?? 65_536,
            defaults,
            capabilities,
            connectTimeoutMs: provider.connectTimeoutMs ?? this.raw.defaults?.connectTimeoutMs ?? 30_000,
            streamIdleTimeoutMs: provider.streamIdleTimeoutMs ?? this.raw.defaults?.streamIdleTimeoutMs ?? 300_000,
            retry: {
                maxAttempts: provider.retry?.maxAttempts ?? this.raw.defaults?.retry?.maxAttempts ?? 3,
                statuses: provider.retry?.statuses ?? this.raw.defaults?.retry?.statuses ?? [429, 500, 502, 503, 504],
            },
            ...(provider.discover ? { discover: provider.discover } : {}),
            errors: { ...(provider.errors ?? {}) },
            ...(family ? { family } : {}),
            ...(model ? { model } : {}),
            source: model ? 'model' : family ? 'family' : 'provider',
            state: 'ok',
            diagnostics,
        };
        if (!SUPPORTED.includes(interfaceType)) {
            diagnostics.push({ path: this.entryPath(model, family, provider), code: 'UNSUPPORTED_FEATURE', severity: 'error', message: `M1 尚未实现 ${interfaceType}` });
        }
        if (capabilities.deferLoading && interfaceType === 'openai-responses') {
            diagnostics.push({ path: `${this.entryPath(model, family, provider)}.capabilities.deferLoading`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: 'deferLoading 不适用于 openai-responses' });
        }
        if (caching === 'explicit' && interfaceType !== 'anthropic-messages') {
            diagnostics.push({ path: `${this.entryPath(model, family, provider)}.caching`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: 'explicit 缓存断点只在 anthropic-messages 上可用' });
        }
        if (capabilities.outputConfigEffort && interfaceType !== 'anthropic-messages') {
            diagnostics.push({ path: `${this.entryPath(model, family, provider)}.capabilities.outputConfigEffort`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: 'outputConfigEffort 只属于 anthropic-messages' });
        }
        if (capabilities.thinkingStyle === 'enable_thinking' || capabilities.thinkingStyle === 'effort_only') {
            if (interfaceType === 'anthropic-messages') {
                diagnostics.push({ path: `${this.entryPath(model, family, provider)}.capabilities.thinkingStyle`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: `${capabilities.thinkingStyle} 不是 Messages 的思考形态` });
            }
        }
        if (capabilities.thinkingStyle === 'extended' || capabilities.thinkingStyle === 'adaptive') {
            if (interfaceType === 'openai-chat-completions') {
                diagnostics.push({ path: `${this.entryPath(model, family, provider)}.capabilities.thinkingStyle`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: `${capabilities.thinkingStyle} 不是 chat-completions 的思考形态` });
            }
        }
        if (capabilities.parallelToolCalls === false && interfaceType !== 'openai-chat-completions') {
            diagnostics.push({ path: `${this.entryPath(model, family, provider)}.capabilities.parallelToolCalls`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: 'parallelToolCalls 开关只在 chat-completions 上可用' });
        }
        if (compat.omitMaxTokens && interfaceType === 'anthropic-messages') {
            diagnostics.push({ path: `${this.entryPath(model, family, provider)}.compat.omitMaxTokens`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: 'Anthropic Messages 必须发送 max_tokens，omitMaxTokens 不适用' });
        }
        if (capabilities.responsesEncryptedReplay && interfaceType !== 'openai-responses') {
            diagnostics.push({ path: `${this.entryPath(model, family, provider)}.capabilities.responsesEncryptedReplay`, code: 'UNSUPPORTED_FEATURE', severity: 'error', message: 'responsesEncryptedReplay 只属于 openai-responses' });
        }
        return effective;
    }
    entryPath(model, family, provider) {
        if (model)
            return `models[${model.id}]`;
        if (family)
            return `families[${family.id}]`;
        return `providers[${provider.id}]`;
    }
    views() {
        const out = [];
        for (const m of this.raw.models ?? []) {
            try {
                const effective = this.resolve(m.id, m.provider);
                out.push(toView(effective));
            }
            catch (cause) {
                out.push({
                    id: m.id,
                    provider: m.provider ?? '',
                    force: m.force ?? this.raw.force ?? false,
                    upstream: m.upstream ?? m.id,
                    interfaceType: m.interfaceType ?? 'openai-chat-completions',
                    contextWindow: m.contextWindow ?? 0,
                    maxOutput: m.maxOutput ?? 0,
                    capabilities: m.capabilities ?? {},
                    defaults: m.defaults ?? {},
                    caching: m.caching ?? 'auto',
                    enabled: m.enabled !== false,
                    source: 'model',
                    state: 'error',
                    diagnostics: [{ path: `models[${m.id}]`, code: 'INVALID_CONFIG', severity: 'error', message: cause.message }],
                });
            }
        }
        return out;
    }
    modelView(id, provider) {
        try {
            const effective = this.resolve(id, provider);
            return toView(effective);
        }
        catch {
            return undefined;
        }
    }
    describe() {
        return redact(this.raw);
    }
}
function enabledCount(providers) {
    return providers.filter((p) => p.enabled !== false).length;
}
function toView(effective) {
    return {
        id: effective.id,
        provider: effective.providerId,
        force: effective.force,
        upstream: effective.upstream,
        interfaceType: effective.interfaceType,
        contextWindow: effective.contextWindow,
        maxOutput: effective.maxOutput,
        capabilities: effective.capabilities,
        defaults: effective.defaults,
        caching: effective.caching,
        enabled: effective.provider.enabled !== false,
        source: effective.source,
        state: effective.state,
        diagnostics: effective.diagnostics,
    };
}
/* --------------------------------------------------------------- redaction */
function maskSecret(value) {
    return value.length <= 12 ? '••••••' : `${value.slice(0, 7)}…${value.slice(-4)}`;
}
const SECRET_HEADER = /authorization|api[-_]?key|token|secret|cookie/i;
export function redact(value) {
    const clone = structuredClone(value);
    for (const provider of clone.providers ?? []) {
        if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0)
            provider.apiKey = maskSecret(provider.apiKey);
        const headers = provider.headers;
        if (headers) {
            for (const key of Object.keys(headers)) {
                if (SECRET_HEADER.test(key))
                    headers[key] = maskSecret(headers[key]);
            }
        }
    }
    return clone;
}
