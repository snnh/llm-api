import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigState, createLLM, parseConfig } from '../dist/index.js';

const base = {
  version: 1,
  defaults: {},
  providers: [
    { id: 'chat', interfaceType: 'openai-chat-completions', baseUrl: 'https://chat.example/v1' },
    { id: 'claude', interfaceType: 'anthropic-messages', baseUrl: 'https://claude.example/v1' },
  ],
  families: [
    { id: 'ds', match: ['deepseek-'], provider: 'chat', contextWindow: 1000000, defaults: { temperature: 0.7 }, capabilities: { tools: true, thinkingStyle: 'thinking' } },
    { id: 'claude', match: ['claude-'], provider: 'claude', contextWindow: 200000, capabilities: { tools: true, thinkingStyle: 'extended' } },
  ],
  models: [
    { id: 'deepseek-reasoner', family: 'ds', upstream: 'deepseek-reasoner', contextWindow: 128000, capabilities: { deferLoading: true } },
  ],
};

test('provider/model addressing resolves to the right endpoint', () => {
  const llm = createLLM(base);
  assert.equal(llm.model('chat/deepseek-chat').provider, 'chat');
  assert.equal(llm.model('chat/deepseek-chat').upstream, 'deepseek-chat');
  assert.equal(llm.model('claude/claude-3').provider, 'claude');
});

test('family match supplies context, defaults and capabilities', () => {
  const llm = createLLM(base);
  const view = llm.model('deepseek-chat');
  assert.equal(view.source, 'family');
  assert.equal(view.contextWindow, 1000000);
  assert.equal(view.defaults.temperature, 0.7);
  assert.equal(view.capabilities.tools, true);
});

test('model entries patch the family instead of replacing it', () => {
  const llm = createLLM({ ...base, models: [{ ...base.models[0], capabilities: { tools: true, deferLoading: true } }] });
  const view = llm.model('deepseek-reasoner', 'chat');
  assert.equal(view.contextWindow, 128000);
  assert.equal(view.defaults.temperature, 0.7);
  assert.equal(view.capabilities.thinkingStyle, 'thinking');
});

test('undeclared model without family match and without provider is ambiguous', () => {
  const parsed = parseConfig(base);
  assert.ok(parsed.config);
  const state = new ConfigState(parsed.config);
  assert.throws(() => state.resolve('unknown-model'), /无法确定端点/);
  assert.equal(createLLM(base).model('unknown-model'), undefined);
});

test('deferLoading is honored on chat-completions and rejected on responses', () => {
  const parsed = parseConfig({
    ...base,
    families: [{ id: 'ds', match: ['deepseek-'], provider: 'chat', capabilities: { deferLoading: true } }],
    models: [],
  });
  assert.ok(parsed.config);
  const state = new ConfigState(parsed.config);
  assert.equal(state.resolve('deepseek-chat').state, 'ok');

  const responsesConfig = {
    version: 1,
    providers: [{ id: 'resp', interfaceType: 'openai-responses', baseUrl: 'https://resp.example/v1' }],
    families: [{ id: 'gpt', match: ['gpt-'], provider: 'resp', capabilities: { deferLoading: true } }],
  };
  const responsesState = new ConfigState(parseConfig(responsesConfig).config);
  const effective = responsesState.resolve('gpt-6-astra');
  assert.equal(effective.state, 'error');
  assert.ok(effective.diagnostics.some((d) => d.path.includes('deferLoading') && d.code === 'UNSUPPORTED_FEATURE'));
});

test('omitMaxTokens is rejected on anthropic-messages', () => {
  const llm = createLLM({
    ...base,
    providers: [{ ...base.providers[1], compat: { omitMaxTokens: true } }],
  });
  const diagnostics = llm.validate();
  assert.ok(diagnostics.some((d) => d.code === 'UNSUPPORTED_FEATURE' && d.path.includes('omitMaxTokens')));
});

test('unknown fields warn by default and fail in strict mode', () => {
  const input = { ...base, providers: [{ ...base.providers[0], future: true }], models: [] };
  const loose = parseConfig(input);
  assert.equal(loose.config !== undefined, true);
  assert.ok(loose.diagnostics.some((d) => d.code === 'UNKNOWN_FIELD' && d.severity === 'warning'));
  const strict = parseConfig(input, { strict: true });
  assert.equal(strict.config, undefined);
});

test('describe never returns raw secrets', () => {
  const llm = createLLM({
    ...base,
    providers: [{ ...base.providers[0], apiKey: 'sk-abcdefghijklmnop', headers: { authorization: 'Bearer top-secret' } }],
  });
  const described = llm.describe();
  assert.equal(described.providers[0].apiKey.includes('abcdefghij'), false);
  assert.equal(described.providers[0].headers.authorization.includes('top-secret'), false);
});
