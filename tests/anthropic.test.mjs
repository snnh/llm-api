import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../dist/index.js';
import { baseConfig, sendJson, sendSse, startMock } from './helpers/mock.mjs';

const jsonResponse = (res, overrides = {}) => sendJson(res, {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 2 },
  ...overrides,
});

test('max_tokens falls back from request to defaults to maxOutput', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.families[1].maxOutput = 65536;
  const llm = createLLM(config);

  await llm.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(mock.captured.at(-1).body.max_tokens, 65536);

  config.families[1].defaults = { maxTokens: 1024 };
  const llm2 = createLLM(config);
  await llm2.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(mock.captured.at(-1).body.max_tokens, 1024);

  await llm2.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'x' }], maxTokens: 2048 });
  assert.equal(mock.captured.at(-1).body.max_tokens, 2048);
  assert.ok(!('temperature' in mock.captured.at(-1).body));
  await mock.close();
});

test('system stays a field; compat.systemPrompt=message folds it into the first user turn', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res));
  t.after(() => mock.close());
  const llm = createLLM(baseConfig(mock.url));
  await llm.chat({ model: 'claude-1', system: 'be brief', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(mock.captured.at(-1).body.system, 'be brief');

  const config = baseConfig(mock.url);
  config.providers[1].compat = { systemPrompt: 'message' };
  const llm2 = createLLM(config);
  await llm2.chat({ model: 'claude-1', system: 'be brief', messages: [{ role: 'user', content: 'x' }] });
  const body = mock.captured.at(-1).body;
  assert.equal(body.system, undefined);
  assert.equal(body.messages[0].content[0].text, 'be brief');
  await mock.close();
});

test('caching explicit marks system, last tool and last message; auto marks nothing', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.providers[1].caching = 'explicit';
  const llm = createLLM(config);
  await llm.chat({
    model: 'claude-1',
    system: 'prefix',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'a', parameters: { type: 'object' } }, { name: 'b', parameters: { type: 'object' } }],
  });
  const body = mock.captured.at(-1).body;
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(body.tools.at(-1).cache_control.type, 'ephemeral');
  assert.equal(body.messages.at(-1).content.at(-1).cache_control.type, 'ephemeral');
  const breakpoints = JSON.stringify(body).match(/cache_control/g)?.length ?? 0;
  assert.ok(breakpoints <= 4);

  config.providers[1].caching = 'auto';
  const llm2 = createLLM(config);
  await llm2.chat({ model: 'claude-1', system: 'prefix', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(JSON.stringify(mock.captured.at(-1).body).includes('cache_control'), false);
  await mock.close();
});

test('deferLoading marks deferred tools and refuses undeclared models', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.families[1].capabilities = { tools: true, deferLoading: true };
  const llm = createLLM(config);
  await llm.chat({
    model: 'claude-1',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'a', parameters: { type: 'object' } }, { name: 'b', parameters: { type: 'object' } }],
    deferredTools: ['b'],
  });
  const tools = mock.captured.at(-1).body.tools;
  assert.equal(tools[0].defer_loading, undefined);
  assert.equal(tools[1].defer_loading, true);

  const strict = createLLM(baseConfig(mock.url));
  await assert.rejects(
    () => strict.chat({
      model: 'claude-2',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'a', parameters: { type: 'object' } }],
      deferredTools: ['a'],
    }),
    (error) => error.code === 'INVALID_REQUEST' && /deferLoading/.test(error.message),
  );
  await mock.close();
});

test('extended thinking uses the caller budget and never invents one', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.families[1].capabilities = { thinkingStyle: 'extended' };
  const llm = createLLM(config);
  await llm.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'x' }], thinking: 'enabled', thinkingBudgetTokens: 2048 });
  assert.deepEqual(mock.captured.at(-1).body.thinking, { type: 'enabled', budget_tokens: 2048 });

  await llm.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'x' }], thinking: 'enabled' });
  assert.deepEqual(mock.captured.at(-1).body.thinking, { type: 'enabled' });
  await mock.close();
});

test('streamed Messages events become text, thinking and usage', async (t) => {
  const mock = await startMock(({ res }) => sendSse(res, [
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'cipher-stream' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hi' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]));
  t.after(() => mock.close());
  const llm = createLLM(baseConfig(mock.url));
  const events = [];
  for await (const event of llm.chatStream({ model: 'claude-1', messages: [{ role: 'user', content: 'x' }] })) events.push(event);
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'Hi');
  const thinkingEnd = events.find((e) => e.type === 'thinking_end' && e.signature);
  assert.equal(thinkingEnd.signature, 'sig-1');
  const redactedEnd = events.find((e) => e.type === 'thinking_end' && e.redacted);
  assert.equal(redactedEnd.redacted, 'cipher-stream');
  const usage = events.find((e) => e.type === 'usage');
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.outputTokens, 4);
  assert.equal(usage.cacheRead, 2);
  assert.equal(usage.cacheWrite, 3);
  assert.equal(events.at(-1).stopReason, 'end_turn');
  await mock.close();
});

test('compat.maxTokensField renames the required output cap', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.providers[1].compat = { maxTokensField: 'max_output_tokens' };
  const llm = createLLM(config);
  await llm.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'x' }] });
  const body = mock.captured.at(-1).body;
  assert.equal(body.max_output_tokens, 65536);
  assert.equal(body.max_tokens, undefined);
  await mock.close();
});

test('mid-conversation system messages update tools and effort', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res));
  t.after(() => mock.close());

  const config = baseConfig(mock.url);
  config.families[1].capabilities = { tools: true, thinkingStyle: 'thinking', outputConfigEffort: true };
  const llm = createLLM(config);
  await llm.chat({
    model: 'claude-1',
    messages: [
      { role: 'user', content: 'question' },
      {
        role: 'system',
        content: 'from now on use the new tool',
        toolChanges: { remove: ['old'], add: ['fresh'] },
        outputConfig: { effort: 'low' },
      },
      { role: 'assistant', content: 'answer' },
    ],
    tools: [
      { name: 'old', parameters: { type: 'object' } },
      { name: 'fresh', parameters: { type: 'object' } },
    ],
  });
  const body = mock.captured.at(-1).body;
  assert.equal(body.messages[1].role, 'system');
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'from now on use the new tool' },
    { type: 'tool_removal', tool: { type: 'tool_reference', name: 'old' } },
    { type: 'tool_addition', tool: { type: 'tool_reference', name: 'fresh' } },
  ]);
  assert.deepEqual(body.messages[1].output_config, { effort: 'low' });
  const beta = mock.captured.at(-1).headers['anthropic-beta'];
  assert.match(beta, /mid-conversation-tool-changes-2026-07-01/);
  assert.match(beta, /mid-conversation-output-config-2026-07-01/);

  await llm.chat({
    model: 'claude-1',
    messages: [
      { role: 'user', content: 'question' },
      { role: 'system', content: [], outputConfig: { effort: 'max' } },
      { role: 'assistant', content: 'answer' },
    ],
    effort: 'high',
  });
  const body2 = mock.captured.at(-1).body;
  assert.deepEqual(body2.messages[1], {
    role: 'system',
    content: [],
    output_config: { effort: 'max' },
  });
  assert.deepEqual(body2.output_config, { effort: 'high' });

  await assert.rejects(
    () => llm.chat({
      model: 'claude-1',
      messages: [
        { role: 'user', content: 'question' },
        { role: 'system', toolChanges: { add: ['missing'] } },
      ],
    }),
    (error) => error.code === 'INVALID_REQUEST' && /未声明的工具/.test(error.message),
  );
});

test('empty-signature and redacted thinking blocks replay verbatim', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res, {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-empty' },
      { type: 'redacted_thinking', data: 'cipher-text' },
      { type: 'text', text: 'ok' },
    ],
  }));
  t.after(() => mock.close());
  const llm = createLLM(baseConfig(mock.url));

  const first = await llm.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(first.thinking.text, '');
  assert.equal(first.thinking.signature, 'sig-empty');
  assert.equal(first.thinking.redacted, 'cipher-text');

  await llm.chat({
    model: 'claude-1',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'ok', reasoning: first.thinking },
      { role: 'user', content: 'next' },
    ],
  });
  const body = mock.captured.at(-1).body;
  assert.deepEqual(body.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-empty' });
  assert.deepEqual(body.messages[1].content[1], { type: 'redacted_thinking', data: 'cipher-text' });
});

test('multiple thinking and redacted blocks keep their order', async (t) => {
  const mock = await startMock(({ res }) => jsonResponse(res, {
    content: [
      { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'cipher-1' },
      { type: 'thinking', thinking: 'more', signature: 'sig-2' },
      { type: 'text', text: 'ok' },
    ],
  }));
  t.after(() => mock.close());
  const llm = createLLM(baseConfig(mock.url));

  const result = await llm.chat({ model: 'claude-1', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(result.thinking.text, 'planmore');
  assert.equal(result.thinking.signature, 'sig-2');
  assert.equal(result.thinking.redacted, 'cipher-1');
  assert.deepEqual(result.thinking.blocks, [
    { type: 'thinking', text: 'plan', signature: 'sig-1' },
    { type: 'redacted_thinking', data: 'cipher-1' },
    { type: 'thinking', text: 'more', signature: 'sig-2' },
  ]);

  await llm.chat({
    model: 'claude-1',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'ok', reasoning: result.thinking },
    ],
  });
  const body = mock.captured.at(-1).body;
  assert.deepEqual(body.messages[1].content, [
    { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
    { type: 'redacted_thinking', data: 'cipher-1' },
    { type: 'thinking', thinking: 'more', signature: 'sig-2' },
    { type: 'text', text: 'ok' },
  ]);
});
