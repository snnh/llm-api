import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM, loadConfig } from '../dist/index.js';
import { sendJson, startMock } from './helpers/mock.mjs';

async function domestic(mock) {
  const config = loadConfig('examples/domestic.config.yaml');
  for (const provider of config.providers) {
    provider.baseUrl = `${mock.url}/v1/${provider.id}`;
    provider.apiKey = 'test-key';
    delete provider.apiKeyEnv;
  }
  return createLLM(config);
}

test('domestic dialect matrix: four vendors, one codebase, config only', async (t) => {
  const mock = await startMock(({ res, req }) => {
    if (req.url.endsWith('/messages')) {
      sendJson(res, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  t.after(() => mock.close());
  const llm = await domestic(mock);
  const ask = (model, extra = {}) => llm.chat({ model, messages: [{ role: 'user', content: 'x' }], ...extra });

  // deepseek: thinking:{type}
  await ask('deepseek-reasoner', { thinking: 'enabled' });
  assert.deepEqual(mock.captured.at(-1).body.thinking, { type: 'enabled' });

  // glm on the Messages wire: same thinking:{type}, auto caching means no breakpoints
  await ask('glm-5', { thinking: 'disabled', system: 'prefix' });
  assert.deepEqual(mock.captured.at(-1).body.thinking, { type: 'disabled' });
  assert.equal(JSON.stringify(mock.captured.at(-1).body).includes('cache_control'), false);

  // qwen: top-level enable_thinking
  await ask('qwen3-max', { thinking: 'enabled' });
  assert.equal(mock.captured.at(-1).body.enable_thinking, true);
  await ask('qwen3-max', { thinking: 'disabled' });
  assert.equal(mock.captured.at(-1).body.enable_thinking, false);

  // kimi k3: effort-only, value is passed through verbatim
  await ask('kimi-k3', { effort: 'max' });
  assert.equal(mock.captured.at(-1).body.reasoning_effort, 'max');

  // kimi-for-coding: fixed thinking, explicit selection still sends the switch
  await ask('kimi-for-coding', { thinking: 'enabled' });
  assert.deepEqual(mock.captured.at(-1).body.thinking, { type: 'enabled' });
});

test('glm deferLoading marks tools; cacheBreakpoints are rejected outside explicit caching', async (t) => {
  const mock = await startMock(({ res, req }) => {
    if (req.url.endsWith('/messages')) {
      sendJson(res, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  t.after(() => mock.close());
  const llm = await domestic(mock);

  await llm.chat({
    model: 'glm-5',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'slow-tool', parameters: { type: 'object' } }],
    deferredTools: ['slow-tool'],
  });
  assert.equal(mock.captured.at(-1).body.tools[0].defer_loading, true);

  await assert.rejects(
    () => llm.chat({ model: 'glm-5', messages: [{ role: 'user', content: 'x' }], cacheBreakpoints: ['m1'] }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /caching: explicit/.test(error.message),
  );
  await assert.rejects(
    () => llm.chat({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'x' }], cacheBreakpoints: ['m1'] }),
    (error) => error.code === 'UNSUPPORTED_FEATURE',
  );
});
