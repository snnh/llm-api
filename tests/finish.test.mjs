import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../dist/index.js';
import { baseConfig, sendJson, startMock } from './helpers/mock.mjs';

test('apply tolerates unchanged broken entries and rejects changes to them', () => {
  const config = baseConfig('http://127.0.0.1:1');
  config.families.push({ id: 'bad', match: ['bad-'], provider: 'mock-chat', caching: 'explicit' });
  const llm = createLLM(config);

  const unrelated = structuredClone(config);
  unrelated.providers[0].headers = { 'x-tenant': 'acme' };
  const tolerated = llm.apply(unrelated);
  assert.equal(tolerated.ok, true);
  assert.ok(tolerated.diagnostics.some((d) => d.code === 'UNSUPPORTED_FEATURE' && d.path.includes('caching')));
  assert.equal(llm.model('bad-1').state, 'error');

  const fixing = structuredClone(unrelated);
  fixing.families.at(-1).caching = 'auto';
  const fixed = llm.apply(fixing);
  assert.equal(fixed.ok, true);
  assert.equal(llm.model('bad-1').state, 'ok');
});

test('concurrency() reports queue depth and peak', async (t) => {
  const mock = await startMock(async ({ res }) => {
    await new Promise((resolve) => setTimeout(resolve, 90));
    sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.providers[0].maxConcurrent = 1;
  const llm = createLLM(config);

  const first = llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'a' }] });
  const second = llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'b' }] });

  let queued = 0;
  for (let i = 0; i < 40; i += 1) {
    queued = llm.concurrency()['mock-chat'].queued;
    if (queued > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(queued, 1);
  await Promise.all([first, second]);
  const after = llm.concurrency()['mock-chat'];
  assert.equal(after.active, 0);
  assert.equal(after.queued, 0);
  assert.equal(after.peak, 1);
});

test('request-level capability checks reject undeclared images, thinking modes and breakpoints', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.families[0].capabilities = { modalities: ['text'], thinking: ['enabled'], thinkingStyle: 'thinking' };
  const llm = createLLM(config);

  await assert.rejects(
    () => llm.chat({
      model: 'chat-1',
      messages: [{ role: 'user', content: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }] }],
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /图片输入/.test(error.message),
  );
  await assert.rejects(
    () => llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }], thinking: 'disabled' }),
    (error) => error.code === 'INVALID_REQUEST' && /思考模式/.test(error.message),
  );
  await assert.rejects(
    () => llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }], cacheBreakpoints: ['m1'] }),
    (error) => error.code === 'UNSUPPORTED_FEATURE',
  );
});

test('force skips runtime capability checks; most specific force wins', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  t.after(() => mock.close());
  const image = { role: 'user', content: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }] };

  const config = baseConfig(mock.url);
  config.force = true;
  config.families[0].capabilities = {
    modalities: ['text'],
    thinking: ['enabled'],
    thinkingStyle: 'thinking',
    tools: false,
  };
  const llm = createLLM(config);
  await llm.chat({
    model: 'chat-1',
    messages: [image],
    thinking: 'disabled',
    tools: [{ name: 'clock', parameters: { type: 'object' } }],
    deferredTools: ['clock'],
  });
  const body = mock.captured.at(-1).body;
  assert.equal(body.messages[0].content[0].type, 'image_url');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.tools[0].defer_loading, true);
  assert.equal(llm.model('chat-1').force, true);

  await assert.rejects(
    () => llm.chat({ model: 'chat-1', messages: [image], cacheBreakpoints: ['m1'] }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /cacheBreakpoints/.test(error.message),
  );
  await assert.rejects(
    () => llm.chat({
      model: 'chat-1',
      messages: [image],
      tools: [{ name: 'clock', parameters: { type: 'object' }, async: true }],
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /异步工具/.test(error.message),
  );

  const override = baseConfig(mock.url);
  override.force = true;
  override.models = [{ id: 'chat-1', force: false }];
  override.families[0].capabilities = { modalities: ['text'] };
  const strict = createLLM(override);
  assert.equal(strict.model('chat-1').force, false);
  await assert.rejects(
    () => strict.chat({ model: 'chat-1', messages: [image] }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /图片输入/.test(error.message),
  );
});

test('mid-conversation system updates are Anthropic-only', async () => {
  const config = baseConfig('http://127.0.0.1:1');
  config.force = true;
  const llm = createLLM(config);
  await assert.rejects(
    () => llm.chat({
      model: 'chat-1',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'system', toolChanges: { add: ['clock'] } },
      ],
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /工具变更/.test(error.message),
  );
});

test('configurationUpdates are rejected outside Responses, even with force', async () => {
  const config = baseConfig('http://127.0.0.1:1');
  config.force = true;
  const llm = createLLM(config);
  await assert.rejects(
    () => llm.chat({
      model: 'chat-1',
      messages: [{ role: 'user', content: 'x' }],
      configurationUpdates: [{ reasoning: { effort: 'high' } }],
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /configurationUpdates/.test(error.message),
  );
});

test('unsupportedParams is advisory: unsupported parameters pass through', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  t.after(() => mock.close());
  const message = [{ role: 'user', content: 'x' }];

  const config = baseConfig(mock.url);
  config.families[0].capabilities = { unsupportedParams: ['temperature', 'topP', 'top_p'] };
  const llm = createLLM(config);

  await llm.chat({ model: 'chat-1', messages: message, temperature: 0 });
  assert.equal(mock.captured.at(-1).body.temperature, 0);

  await llm.chat({ model: 'chat-1', messages: message, extra: { top_p: 0.5 } });
  assert.equal(mock.captured.at(-1).body.top_p, 0.5);

  const withStatic = baseConfig(mock.url);
  withStatic.families[0].capabilities = { unsupportedParams: ['top_p'] };
  withStatic.families[0].extraBody = { top_p: 0.5 };
  await createLLM(withStatic).chat({ model: 'chat-1', messages: message });
  assert.equal(mock.captured.at(-1).body.top_p, 0.5);

  const withDefaults = baseConfig(mock.url);
  withDefaults.families[0].capabilities = { unsupportedParams: ['temperature'] };
  withDefaults.families[0].defaults = { temperature: 0.5 };
  await createLLM(withDefaults).chat({ model: 'chat-1', messages: message });
  assert.equal(mock.captured.at(-1).body.temperature, 0.5);
});

test('messageFields are injected into every chat message', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.providers[0].messageFields = { tenant: 'acme' };
  const llm = createLLM(config);
  await llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] });
  for (const message of mock.captured[0].body.messages) assert.equal(message.tenant, 'acme');
});

test('parallelToolCalls is rejected on non-chat interfaces at validation time', () => {
  const config = baseConfig('http://127.0.0.1:1');
  config.families[1].capabilities = { parallelToolCalls: false, thinkingStyle: 'extended' };
  const llm = createLLM(config);
  const diagnostics = llm.validate();
  assert.ok(diagnostics.some((d) => d.code === 'UNSUPPORTED_FEATURE' && d.path.includes('parallelToolCalls')));
});
