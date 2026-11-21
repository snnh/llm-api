import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../dist/index.js';
import { baseConfig, sendJson, sendSse, startMock } from './helpers/mock.mjs';

const responsesConfig = (url) => ({
  version: 1,
  providers: [
    { id: 'resp', interfaceType: 'openai-responses', baseUrl: `${url}/v1`, apiKey: 'test-key' },
  ],
  families: [
    { id: 'resp', match: ['r-'], provider: 'resp', contextWindow: 400000, capabilities: { tools: true, thinkingStyle: 'effort_only' } },
  ],
});

test('responses non-stream maps items to text and tools, and omits unconfigured caps', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'resp ok' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'clock', arguments: '{"tz":"UTC"}', async: true },
    ],
    usage: { input_tokens: 4, output_tokens: 2 },
  }));
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  const result = await llm.chat({ model: 'r-1', system: 'be terse', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.text, 'resp ok');
  assert.deepEqual(result.toolCalls[0].input, { tz: 'UTC' });
  assert.equal(result.toolCalls[0].async, true);
  assert.equal(result.toolCalls[0].itemId, 'fc_1');
  assert.equal(result.stopReason, 'tool_use');
  const body = mock.captured[0].body;
  assert.equal(body.instructions, 'be terse');
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content[0].text, 'x');
  assert.equal(body.temperature, undefined);
});

test('jsonMode maps to Responses text.format', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  await llm.chat({ model: 'r-1', messages: [{ role: 'user', content: 'x' }], jsonMode: true });
  assert.deepEqual(mock.captured[0].body.text, { format: { type: 'json_object' } });
});

test('configurationUpdates are inserted before the latest user message', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  await llm.chat({
    model: 'r-1',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ],
    configurationUpdates: [
      { reasoning: { effort: 'high' } },
      { text: { format: { type: 'json_object' } } },
    ],
  });
  const input = mock.captured[0].body.input;
  assert.equal(input[0].content[0].text, 'first');
  assert.equal(input[1].role, 'assistant');
  assert.deepEqual(input[2], { type: 'configuration_update', reasoning: { effort: 'high' } });
  assert.deepEqual(input[3], { type: 'configuration_update', text: { format: { type: 'json_object' } } });
  assert.equal(input[4].content[0].text, 'second');
});

test('responses stream parses deltas, function calls and usage', async (t) => {
  const mock = await startMock(({ res }) => sendSse(res, [
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'he' } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'llo' } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_9', call_id: 'c9', name: 'clock', arguments: '' } } },
    { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', call_id: 'c9', delta: '{"tz":' } },
    { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', call_id: 'c9', delta: '"UTC"}' } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_9', call_id: 'c9', name: 'clock', arguments: '{"tz":"UTC"}', async: true } } },
    { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } } } },
  ]));
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  const events = [];
  for await (const event of llm.chatStream({ model: 'r-1', messages: [{ role: 'user', content: 'x' }] })) events.push(event);
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'hello');
  const call = events.find((e) => e.type === 'tool_call');
  assert.equal(call.id, 'c9');
  assert.deepEqual(call.input, { tz: 'UTC' });
  assert.equal(call.itemId, 'fc_9');
  assert.equal(call.async, true);
  const usage = events.find((e) => e.type === 'usage');
  assert.equal(usage.inputTokens, 7);
  assert.equal(events.at(-1).stopReason, 'tool_use');
});

test('embed and rerank use provider endpoint mappings and canonical fields', async (t) => {
  const mock = await startMock(({ res, req }) => {
    if (req.url.endsWith('/embeddings')) {
      sendJson(res, { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3] }], usage: { prompt_tokens: 5 } });
      return;
    }
    if (req.url.endsWith('/rerank')) {
      sendJson(res, { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] });
      return;
    }
    sendJson(res, {});
  });
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  const embedded = await llm.embed({ model: 'r-1', input: ['a', 'b'] });
  assert.deepEqual(embedded.vectors, [[0.1, 0.2], [0.3]]);
  assert.equal(embedded.usage.inputTokens, 5);
  assert.deepEqual(mock.captured[0].body, { model: 'r-1', input: ['a', 'b'] });

  const reranked = await llm.rerank({ model: 'r-1', query: 'q', documents: ['a', 'b'], topN: 2 });
  assert.deepEqual(reranked.results, [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
  assert.equal(mock.captured[1].body.top_n, 2);
});

test('refresh caches discovered models and models() exposes them', async (t) => {
  const mock = await startMock(({ res, req }) => {
    if (req.url.endsWith('/models')) {
      sendJson(res, { data: [{ id: 'zz-live', context_window: 1234 }] });
      return;
    }
    sendJson(res, {});
  });
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  const candidates = await llm.refresh('resp');
  assert.equal(candidates[0].id, 'zz-live');
  const view = llm.model('zz-live', 'resp');
  assert.equal(view.source, 'discovered');
  assert.equal(view.contextWindow, 1234);
  assert.ok(llm.models().some((model) => model.id === 'zz-live'));
});

test('maxConcurrent queues requests per provider', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const mock = await startMock(async ({ res }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 60));
    inFlight -= 1;
    sendJson(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.providers[0].maxConcurrent = 1;
  const llm = createLLM(config);
  await Promise.all([
    llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'a' }] }),
    llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'b' }] }),
  ]);
  assert.equal(peak, 1);
});

test('image generation reads url / b64 payloads', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, { data: [{ url: 'https://img/1.png' }, { b64_json: 'AAAA', media_type: 'image/png' }] }));
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  const result = await llm.image({ model: 'r-1', prompt: 'a cat', n: 2 });
  assert.equal(result.images[0].url, 'https://img/1.png');
  assert.equal(result.images[1].b64, 'AAAA');
  assert.equal(mock.captured[0].body.prompt, 'a cat');
  assert.equal(mock.captured[0].body.n, 2);
});

test('promptCacheOptions maps to Responses and is rejected elsewhere or with invalid values', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  t.after(() => mock.close());

  const llm = createLLM(responsesConfig(mock.url));
  await llm.chat({
    model: 'r-1',
    messages: [{ role: 'user', content: 'x' }],
    promptCacheOptions: { mode: 'explicit', ttl: '12h', prewarm: true },
    promptCacheKey: 'tenant:1',
  });
  const body = mock.captured.at(-1).body;
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '12h', prewarm: true });
  assert.equal(body.prompt_cache_key, 'tenant:1');
  assert.equal(body.promptCacheOptions, undefined);
  assert.equal(body.promptCacheKey, undefined);

  await llm.chat({
    model: 'r-1',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'stable', promptCacheBreakpoint: { mode: 'explicit', ttl: '12h' } }],
    }],
  });
  assert.deepEqual(mock.captured.at(-1).body.input[0].content[0].prompt_cache_breakpoint, {
    mode: 'explicit',
    ttl: '12h',
  });

  const chat = createLLM(baseConfig(mock.url));
  await assert.rejects(
    () => chat.chat({
      model: 'chat-1',
      messages: [{ role: 'user', content: 'x' }],
      promptCacheOptions: { ttl: '30m' },
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /promptCacheOptions/.test(error.message),
  );
  await assert.rejects(
    () => chat.chat({
      model: 'chat-1',
      messages: [{ role: 'user', content: 'x' }],
      promptCacheKey: 'tenant:1',
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /promptCacheKey/.test(error.message),
  );

  await assert.rejects(
    () => llm.chat({ model: 'r-1', messages: [{ role: 'user', content: 'x' }], promptCacheOptions: { ttl: '1h' } }),
    (error) => error.code === 'INVALID_REQUEST' && /ttl/.test(error.message),
  );
  await assert.rejects(
    () => llm.chat({ model: 'r-1', messages: [{ role: 'user', content: 'x' }], promptCacheOptions: { mode: 'auto' } }),
    (error) => error.code === 'INVALID_REQUEST' && /mode/.test(error.message),
  );
  await assert.rejects(
    () => chat.chat({
      model: 'chat-1',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'stable', promptCacheBreakpoint: { mode: 'explicit' } }],
      }],
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /promptCacheBreakpoint/.test(error.message),
  );
});

test('prewarm responses may have no output items', async (t) => {
  const mock = await startMock(({ res, body }) => sendJson(res, {
    status: 'completed',
    output: body.prompt_cache_options?.prewarm ? [] : [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 1, output_tokens: 0 },
  }));
  t.after(() => mock.close());
  const llm = createLLM(responsesConfig(mock.url));
  const warm = await llm.chat({
    model: 'r-1',
    messages: [{ role: 'user', content: 'x' }],
    promptCacheOptions: { prewarm: true },
  });
  assert.equal(warm.text, '');
  assert.deepEqual(warm.toolCalls, []);
  assert.deepEqual(mock.captured.at(-1).body.prompt_cache_options, { prewarm: true });
});
