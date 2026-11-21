import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../dist/index.js';
import { baseConfig, sendJson, sendSse, startMock } from './helpers/mock.mjs';

test('aliases resolve to the same declared model', () => {
  const config = baseConfig('http://127.0.0.1:1');
  config.models = [{ id: 'main', aliases: ['fast', 'cheap'], provider: 'mock-chat', family: 'chat', upstream: 'chat-upstream' }];
  const llm = createLLM(config);
  assert.equal(llm.model('fast').id, 'main');
  assert.equal(llm.model('cheap').upstream, 'chat-upstream');
});

test('a model can override the provider protocol (mixed-protocol endpoint)', async (t) => {
  const mock = await startMock(({ res, req }) => {
    if (req.url.endsWith('/messages')) {
      sendJson(res, { content: [{ type: 'text', text: 'anthropic path' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    sendJson(res, {});
  });
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.models = [{ id: 'mixed', provider: 'mock-chat', family: 'chat', interfaceType: 'anthropic-messages' }];
  const llm = createLLM(config);
  const result = await llm.chat({ model: 'mixed', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.text, 'anthropic path');
  assert.ok(mock.captured[0].path.endsWith('/messages'));
  assert.equal(mock.captured[0].body.max_tokens, 65536);
});

test('in-flight requests keep their snapshot across apply()', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = await startMock(async ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first "}}]}\n\n');
    await gate;
    res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const other = await startMock(({ res }) => sendJson(res, { choices: [{ message: { content: 'other' }, finish_reason: 'stop' }] }));
  t.after(() => { slow.close(); other.close(); });

  const config = baseConfig(slow.url);
  config.models = [{ id: 'main', provider: 'mock-chat', family: 'chat' }];
  const llm = createLLM(config);
  const events = [];
  const iterator = llm.chatStream({ model: 'main', messages: [{ role: 'user', content: 'x' }] });
  for await (const event of iterator) {
    events.push(event);
    if (event.type === 'text_delta' && event.text === 'first ') {
      const next = baseConfig(other.url);
      next.models = [{ id: 'main', provider: 'mock-chat', family: 'chat' }];
      llm.apply(next);
      release();
    }
  }
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'first second');
  assert.equal(other.captured.length, 0);
});

test('abort surfaces as an ABORTED error event and chat() throws', async (t) => {
  const mock = await startMock(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  t.after(() => mock.close());
  const llm = createLLM(baseConfig(mock.url));
  const controller = new AbortController();
  const events = [];
  const iterator = llm.chatStream({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }], signal: controller.signal });
  for await (const event of iterator) {
    events.push(event);
    if (event.type === 'text_delta') controller.abort(new Error('stop now'));
    if (event.type === 'error') break;
  }
  const error = events.find((e) => e.type === 'error');
  assert.ok(error, 'error event emitted');
  assert.equal(error.error.code, 'ABORTED');

  const controller2 = new AbortController();
  controller2.abort(new Error('already gone'));
  await assert.rejects(
    () => llm.chat({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }], signal: controller2.signal }),
    (cause) => cause.code === 'ABORTED',
  );
});

test('stream idle timeout fails the request instead of hanging', async (t) => {
  const mock = await startMock(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"slow"}}]}\n\n');
  });
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.providers[0].streamIdleTimeoutMs = 120;
  const llm = createLLM(config);
  const events = [];
  for await (const event of llm.chatStream({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }] })) {
    events.push(event);
    if (event.type === 'error') break;
  }
  const error = events.find((e) => e.type === 'error');
  assert.ok(error);
  assert.equal(error.error.code, 'TRANSPORT');
});
