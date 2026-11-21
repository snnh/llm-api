import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../dist/index.js';
import { baseConfig, sendJson, sendSse, startMock } from './helpers/mock.mjs';

test('chat() sends only model + messages when nothing else is configured', async () => {
  const mock = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const llm = createLLM(baseConfig(mock.url));
  await llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(Object.keys(mock.captured[0].body).sort(), ['messages', 'model']);
  assert.equal(mock.captured[0].body.stream, undefined);
  await mock.close();
});

test('chatStream assembles tool arguments across frames and reports usage', async () => {
  const mock = await startMock(({ res }) => sendSse(res, [
    { data: { choices: [{ delta: { content: 'Hel' } }] } },
    { data: { choices: [{ delta: { content: 'lo' } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'clock', arguments: '{"tz":' } }] } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] } }] } },
    { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
    'data: [DONE]\n\n',
  ]));
  const llm = createLLM(baseConfig(mock.url));
  const events = [];
  for await (const event of llm.chatStream({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }] })) events.push(event);
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'Hello');
  const call = events.find((e) => e.type === 'tool_call');
  assert.deepEqual(call.input, { tz: 'UTC' });
  assert.equal(call.id, 'c1');
  const usage = events.find((e) => e.type === 'usage');
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).stopReason, 'tool_use');
  assert.equal(mock.captured[0].body.stream, true);
  await mock.close();
});

test('includeUsage adds stream_options only when enabled', async () => {
  const mock = await startMock(({ res }) => sendSse(res, ['data: [DONE]\n\n']));
  const config = baseConfig(mock.url);
  config.providers[0].includeUsage = true;
  const llm = createLLM(config);
  for await (const _ of llm.chatStream({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
  assert.deepEqual(mock.captured[0].body.stream_options, { include_usage: true });
  await mock.close();
});

test('thinking style and effort are sent verbatim, never mapped', async () => {
  const mock = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const config = baseConfig(mock.url);
  config.families[0].capabilities = { thinkingStyle: 'effort_only' };
  const llm = createLLM(config);
  await llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }], effort: 'ultra' });
  assert.equal(mock.captured[0].body.reasoning_effort, 'ultra');

  const mock2 = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const config2 = baseConfig(mock2.url);
  config2.families[0].capabilities = { thinkingStyle: 'thinking' };
  const llm2 = createLLM(config2);
  await llm2.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }], thinking: 'enabled' });
  assert.deepEqual(mock2.captured[0].body.thinking, { type: 'enabled' });
  await mock.close();
  await mock2.close();
});

test('reasoning_content is parsed and replayed when reasoningContent is declared', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    choices: [{ message: { content: 'ok', reasoning_content: 'why' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.families[0].capabilities = { tools: true, reasoningContent: true };
  const llm = createLLM(config);
  const result = await llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(result.thinking.text, 'why');

  await llm.chat({
    model: 'chat-1',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', reasoning: { text: 'why' }, content: 'ok' },
      { role: 'user', content: 'next' },
    ],
  });
  assert.equal(mock.captured.at(-1).body.messages[1].reasoning_content, 'why');
});

test('extraBody then passthrough then extra; undefined and empty values are dropped', async () => {
  const mock = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const config = baseConfig(mock.url);
  config.providers[0].extraBody = { top_k: 40, keep: true };
  const llm = createLLM(config);
  await llm.chat({
    model: 'chat-1',
    messages: [{ role: 'user', content: 'x' }],
    topK: 42,
    extra: { x: 1 },
    temperature: undefined,
    stop: [],
  });
  const body = mock.captured[0].body;
  assert.equal(body.top_k, 42);
  assert.equal(body.keep, true);
  assert.equal(body.x, 1);
  assert.ok(!('temperature' in body));
  assert.ok(!('stop' in body));
  await mock.close();
});

test('401 maps to MISSING_CREDENTIAL with provider and model', async () => {
  const mock = await startMock(({ res }) => sendJson(res, { error: { message: 'bad key' } }, 401));
  const config = baseConfig(mock.url);
  config.providers[0].path = '/unauthorized';
  const llm = createLLM(config);
  await assert.rejects(
    () => llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }] }),
    (error) => error.code === 'MISSING_CREDENTIAL' && error.status === 401 && error.provider === 'mock-chat',
  );
  await mock.close();
});

test('429 is retried with Retry-After before failing the request', async () => {
  let calls = 0;
  const mock = await startMock(({ res }) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }
    sendJson(res, { choices: [{ message: { content: 'after retry' }, finish_reason: 'stop' }] });
  });
  const llm = createLLM(baseConfig(mock.url));
  const result = await llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.text, 'after retry');
  assert.equal(calls, 2);
  await mock.close();
});
