import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM, loadConfig } from '../dist/index.js';
import { sendJson, sendSse, startMock } from './helpers/mock.mjs';

const PRESET = 'presets/mainstream-2026-11.config.yaml';

test('mainstream preset loads clean and resolves every flagship', () => {
  const config = loadConfig(PRESET);
  const llm = createLLM(config);
  const diagnostics = llm.validate();
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);

  const expectations = [
    ['deepseek-v4-pro', 'deepseek', 1000000, 384000],
    ['deepseek-v4.1-flash', 'deepseek', 1000000, 384000],
    ['deepseek-flash', 'deepseek-responses', 1000000, 384000],
    ['deepseek-v4-pro-responses', 'deepseek-responses', 1000000, 384000],
    ['deepseek-flash-anthropic', 'deepseek-anthropic', 1000000, 384000],
    ['deepseek-v4-pro-anthropic', 'deepseek-anthropic', 1000000, 384000],
    ['qwen3.8-max', 'qwen', 1000000, 65536],
    ['qwen3.8-flash', 'qwen', 1000000, 65536],
    ['glm-5.3', 'zhipu', 1000000, 128000],
    ['kimi-k3', 'moonshot', 1000000, 128000],
    ['MiniMax-M3.1-Flash', 'minimax', 1000000, 128000],
    ['claude-opus-5-5', 'anthropic', 1000000, 128000],
    ['claude-sonnet-5-5', 'anthropic', 1000000, 128000],
    ['gpt-6-astra', 'openai', 1050000, 128000],
    ['gpt-6.2-astra', 'openai', 1050000, 128000],
    ['gpt-6.2-sol', 'openai', 1050000, 128000],
    ['gemini-4-argon', 'google', 1048576, 65536],
    ['gemini-4-argon-native', 'google-native', 1048576, 65536],
    ['gemini-3.8-flash-native', 'google-native', 1000000, 65536],
    ['grok-4.7', 'xai', 500000, 65536],
    ['mistral-large-4', 'mistral', 1000000, 65536],
    ['ernie-5.0', 'baidu', 256000, 65536],
    ['hy3', 'tencent', 256000, 65536],
    ['step-3.7-flash', 'stepfun', 256000, 65536],
    ['doubao-seed-any', 'bytedance', 256000, 65536],
  ];
  for (const [id, provider, contextWindow, maxOutput] of expectations) {
    const view = llm.model(id);
    assert.ok(view, `未解析：${id}`);
    assert.equal(view.provider, provider, `${id} provider`);
    assert.equal(view.contextWindow, contextWindow, `${id} context`);
    assert.equal(view.maxOutput, maxOutput, `${id} output`);
    assert.equal(view.state, 'ok', `${id} state`);
  }
});

test('preset declares each vendor dialect exactly once', () => {
  const llm = createLLM(loadConfig(PRESET));
  assert.equal(llm.model('glm-5.3').capabilities.thinkingStyle, 'fixed');
  assert.equal(llm.model('glm-5.2').capabilities.thinkingStyle, 'thinking');
  assert.equal(llm.model('qwen3.8-max').capabilities.thinkingStyle, 'enable_thinking');
  assert.equal(llm.model('kimi-k3').capabilities.thinkingStyle, 'effort_only');
  assert.equal(llm.model('kimi-k3').capabilities.deferLoading, true);
  assert.equal(llm.model('deepseek-v4-pro').capabilities.deferLoading, true);
  assert.equal(llm.model('deepseek-flash').capabilities.thinkingStyle, 'effort_only');
  assert.equal(llm.model('deepseek-flash').capabilities.reasoningContent, true);
  assert.equal(llm.model('deepseek-flash-anthropic').capabilities.outputConfigEffort, true);
  assert.equal(llm.model('MiniMax-M3.1-Flash').capabilities.thinkingStyle, 'effort_only');
  assert.equal(llm.model('claude-opus-5-5').capabilities.thinkingStyle, 'adaptive');
  assert.equal(llm.model('gpt-6-astra').capabilities.responsesEncryptedReplay, true);
  assert.equal(llm.model('gemini-4-argon').interfaceType, 'openai-chat-completions');
  assert.equal(llm.model('gemini-4-argon-native').interfaceType, 'gemini-generate-content');
  assert.equal(llm.model('gemini-4-argon-native').capabilities.thinkingStyle, 'effort_only');
  assert.equal(llm.model('gpt-6.2-astra').capabilities.thinkingStyle, 'effort_only');
  assert.deepEqual(llm.model('gpt-6.2-astra').capabilities.effort, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(llm.model('gpt-6.2-astra').capabilities.thinking, ['enabled']);
  assert.deepEqual(llm.model('gpt-6.2-astra').capabilities.unsupportedParams, [
    'temperature', 'topP', 'top_p', 'topLogprobs', 'top_logprobs', 'logprobs',
  ]);
  assert.equal(llm.model('grok-4.7').capabilities.thinkingStyle, 'effort_only');
  // 同前缀家族按最长匹配取胜
  assert.equal(llm.model('glm-5.3').source, 'model');
  assert.equal(llm.model('glm-5.3-flash').provider, 'zhipu');
  // provider/model 寻址
  assert.equal(llm.model('zhipu/glm-5.3').provider, 'zhipu');
});

test('preset carries no pricing fields', () => {
  const llm = createLLM(loadConfig(PRESET));
  assert.equal(JSON.stringify(llm.describe()).includes('pricing'), false);
});

test('preset requests hit the right wire shapes', async (t) => {
  const mock = await startMock(({ res, req, body }) => {
    if (req.url.endsWith('/messages')) {
      sendJson(res, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    if (req.url.endsWith('/responses')) {
      sendJson(res, {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return;
    }
    if (req.url.includes(':generateContent')) {
      sendJson(res, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
      return;
    }
    void body;
    sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  t.after(() => mock.close());

  const config = loadConfig(PRESET);
  for (const provider of config.providers) {
    provider.baseUrl = `${mock.url}/v1/${provider.id}`;
    provider.apiKey = 'test-key';
    delete provider.apiKeyEnv;
  }
  const llm = createLLM(config);
  const ask = (model, extra = {}) => llm.chat({ model, messages: [{ role: 'user', content: 'x' }], ...extra });
  const lastBody = () => mock.captured.at(-1).body;

  // GLM-5.3：Anthropic 协议 + 恒开思考 + effort -> output_config.effort
  await ask('glm-5.3', { effort: 'max' });
  assert.deepEqual(lastBody().thinking, { type: 'enabled' });
  assert.deepEqual(lastBody().output_config, { effort: 'max' });

  // Qwen3.8：enable_thinking
  await ask('qwen3.8-max', { thinking: 'enabled' });
  assert.equal(lastBody().enable_thinking, true);

  // Kimi K3：reasoning_effort + 动态工具加载
  await ask('kimi-k3', { effort: 'high', tools: [{ name: 'slow', parameters: { type: 'object' } }], deferredTools: ['slow'] });
  assert.equal(lastBody().reasoning_effort, 'high');
  assert.equal(lastBody().tools[0].defer_loading, true);

  // DeepSeek V4：thinking:{type} + defer_loading
  await ask('deepseek-v4-pro', { thinking: 'enabled', tools: [{ name: 'slow', parameters: { type: 'object' } }], deferredTools: ['slow'] });
  assert.deepEqual(lastBody().thinking, { type: 'enabled' });
  assert.equal(lastBody().tools[0].defer_loading, true);

  // DeepSeek Responses：reasoning.effort + plain-text reasoning 回放，不发 include
  await ask('deepseek-flash', { effort: 'max' });
  assert.deepEqual(lastBody().reasoning, { effort: 'max' });
  assert.equal(lastBody().include, undefined);
  await llm.chat({
    model: 'deepseek-flash',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', reasoning: { text: 'plan' }, content: 'a' },
    ],
  });
  assert.deepEqual(lastBody().input.find((item) => item.type === 'reasoning'), {
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'plan' }],
  });

  // DeepSeek Chat：reasoning_content 回放
  await llm.chat({
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', reasoning: { text: 'why' }, content: 'a' },
      { role: 'user', content: 'next' },
    ],
  });
  assert.equal(lastBody().messages[1].reasoning_content, 'why');

  // MiniMax M3.1：max_completion_tokens（只在给了上限时发）+ reasoning_effort
  await ask('MiniMax-M3.1-Flash', { effort: 'max' });
  assert.equal(lastBody().max_completion_tokens, undefined);
  assert.equal(lastBody().reasoning_effort, 'max');
  await ask('MiniMax-M3.1-Flash', { effort: 'max', maxTokens: 1024 });
  assert.equal(lastBody().max_completion_tokens, 1024);

  // Claude 5.5：adaptive + output_config.effort + 显式缓存断点
  await ask('claude-opus-5-5', { effort: 'xhigh', system: 'prefix' });
  assert.deepEqual(lastBody().thinking, { type: 'adaptive' });
  assert.deepEqual(lastBody().output_config, { effort: 'xhigh' });
  assert.deepEqual(lastBody().system[0].cache_control, { type: 'ephemeral' });

  // GPT-6：responses + reasoning.effort + 加密推理回放
  await ask('gpt-6-astra', { effort: 'high' });
  assert.deepEqual(lastBody().reasoning, { effort: 'high' });
  assert.deepEqual(lastBody().include, ['reasoning.encrypted_content']);
  assert.equal(lastBody().max_output_tokens, undefined);
  await ask('gpt-6-astra', { effort: 'high', maxTokens: 2048 });
  assert.equal(lastBody().max_output_tokens, 2048);

  // GPT-6.2：推理常开、medium 起步、拒绝采样参数
  await ask('gpt-6.2-astra', { effort: 'medium' });
  assert.deepEqual(lastBody().reasoning, { effort: 'medium' });
  assert.equal(lastBody().include[0], 'reasoning.encrypted_content');
  // 不支持的参数只作建议，原样透传，错误交给上游
  await ask('gpt-6.2-astra', { temperature: 0.2, extra: { top_p: 0.9 } });
  assert.equal(lastBody().temperature, 0.2);
  assert.equal(lastBody().top_p, 0.9);
  await ask('gpt-6.2-astra', { effort: 'none' });
  assert.deepEqual(lastBody().reasoning, { effort: 'none' });

  // GPT-6.2：异步工具（Responses 专属）
  await ask('gpt-6.2-astra', {
    effort: 'medium',
    tools: [{ name: 'slow', parameters: { type: 'object' }, async: true }],
  });
  assert.equal(lastBody().tools[0].async, true);
  await assert.rejects(
    ask('qwen3.8-max', { tools: [{ name: 'slow', parameters: { type: 'object' }, async: true }] }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /异步工具/.test(error.message),
  );

  // DeepSeek Anthropic：thinking + output_config.effort + 末尾工具变更
  await ask('deepseek-flash-anthropic', { thinking: 'enabled', effort: 'max' });
  assert.ok(mock.captured.at(-1).path.endsWith('/v1/messages'));
  assert.deepEqual(lastBody().thinking, { type: 'enabled' });
  assert.deepEqual(lastBody().output_config, { effort: 'max' });
  await llm.chat({
    model: 'deepseek-flash-anthropic',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'system', toolChanges: { add: ['clock'] }, outputConfig: { effort: 'low' } },
      { role: 'assistant', content: 'a' },
    ],
    tools: [{ name: 'clock', parameters: { type: 'object' } }],
  });
  assert.deepEqual(lastBody().messages[1], {
    role: 'system',
    content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'clock' } }],
    output_config: { effort: 'low' },
  });
  assert.match(mock.captured.at(-1).headers['anthropic-beta'], /mid-conversation-tool-changes/);

  // Gemini 4：原生 generateContent + systemInstruction + functionDeclarations
  await ask('gemini-4-argon-native', {
    system: 'be terse',
    tools: [{ name: 'clock', parameters: { type: 'object' } }],
    effort: 'high',
  });
  assert.ok(mock.captured.at(-1).path.endsWith('/models/gemini-4-argon:generateContent'));
  assert.equal(mock.captured.at(-1).headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(lastBody().systemInstruction, { parts: [{ text: 'be terse' }] });
  assert.equal(lastBody().contents[0].parts[0].text, 'x');
  assert.equal(lastBody().tools[0].functionDeclarations[0].name, 'clock');
  assert.equal(lastBody().tools[0].functionDeclarations[0].description, '');
  assert.deepEqual(lastBody().generationConfig.thinkingConfig, { thinkingLevel: 'high' });

  // Mistral Large 4：max_completion_tokens
  await ask('mistral-large-4', { maxTokens: 1024 });
  assert.equal(lastBody().max_completion_tokens, 1024);
});
