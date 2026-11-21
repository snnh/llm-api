import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../dist/index.js';
import { sendJson, sendSse, startMock } from './helpers/mock.mjs';

const config = (url) => ({
  version: 1,
  providers: [
    { id: 'resp', interfaceType: 'openai-responses', baseUrl: `${url}/v1`, apiKey: 'k' },
  ],
  families: [
    {
      id: 'gpt',
      match: ['gpt-'],
      provider: 'resp',
      contextWindow: 400000,
      capabilities: { tools: true, responsesEncryptedReplay: true, thinkingStyle: 'effort_only' },
    },
  ],
});

test('encrypted reasoning and function-call ids are replayed verbatim', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  t.after(() => mock.close());
  const llm = createLLM(config(mock.url));
  await llm.chat({
    model: 'gpt-5',
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        reasoning: { text: 'why', signature: 'rs_1', encrypted: 'ENC' },
        toolCalls: [{ id: 'call_1', name: 'clock', input: {}, itemId: 'fc_1', async: true }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'noon' },
    ],
  });
  const body = mock.captured[0].body;
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  const reasoning = body.input.find((item) => item.type === 'reasoning');
  assert.equal(reasoning.id, 'rs_1');
  assert.equal(reasoning.encrypted_content, 'ENC');
  const call = body.input.find((item) => item.type === 'function_call');
  assert.equal(call.id, 'fc_1');
  assert.equal(call.call_id, 'call_1');
  assert.equal(call.async, true);
});

test('plain-text reasoning items are parsed and can be replayed', async (t) => {
  const mock = await startMock(({ res, body }) => {
    if (body.stream) {
      sendSse(res, [
        { event: 'response.reasoning_text.delta', data: { type: 'response.reasoning_text.delta', delta: 'plan' } },
        { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_p', content: [{ type: 'reasoning_text', text: 'plan' }] } } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'answer' } },
        { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } } } },
      ]);
      return;
    }
    sendJson(res, {
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_p', content: [{ type: 'reasoning_text', text: 'plan' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      ],
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  });
  t.after(() => mock.close());
  const cfg = config(mock.url);
  cfg.families[0].capabilities = { thinkingStyle: 'effort_only', reasoningContent: true };
  const llm = createLLM(cfg);
  const result = await llm.chat({ model: 'gpt-5', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(result.thinking.text, 'plan');
  assert.equal(result.text, 'answer');

  await llm.chat({
    model: 'gpt-5',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', reasoning: { text: 'plan' }, content: 'answer' },
    ],
  });
  const replay = mock.captured.at(-1).body.input.find((item) => item.type === 'reasoning');
  assert.deepEqual(replay, { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'plan' }] });

  const events = [];
  for await (const event of llm.chatStream({ model: 'gpt-5', messages: [{ role: 'user', content: 'q' }] })) events.push(event);
  assert.equal(events.filter((e) => e.type === 'thinking_delta').map((e) => e.text).join(''), 'plan');
  assert.equal(events.find((e) => e.type === 'thinking_end').text, 'plan');
});

test('reasoning items surface the encrypted payload (non-stream and stream)', async (t) => {
  const mock = await startMock(({ res, body }) => {
    if (body.stream) {
      sendSse(res, [
        { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: 'think' } },
        { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC9', summary: [{ type: 'summary_text', text: 'think' }] } } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'answer' } },
        { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } } } },
      ]);
      return;
    }
    sendJson(res, {
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC9', summary: [{ type: 'summary_text', text: 'think' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      ],
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  });
  t.after(() => mock.close());
  const llm = createLLM(config(mock.url));
  const result = await llm.chat({ model: 'gpt-5', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(result.text, 'answer');
  assert.equal(result.thinking.encrypted, 'ENC9');
  assert.equal(result.thinking.signature, 'rs_9');

  const events = [];
  for await (const event of llm.chatStream({ model: 'gpt-5', messages: [{ role: 'user', content: 'q' }] })) events.push(event);
  const end = events.find((event) => event.type === 'thinking_end');
  assert.equal(end.encrypted, 'ENC9');
  assert.equal(end.text, 'think');
});
