import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../dist/index.js';
import { sendJson, sendSse, startMock } from './helpers/mock.mjs';

const geminiConfig = (url) => ({
  version: 1,
  providers: [
    {
      id: 'gemini',
      interfaceType: 'gemini-generate-content',
      baseUrl: `${url}/v1beta`,
      apiKey: 'gemini-key',
    },
  ],
  families: [
    {
      id: 'gemini',
      match: ['gemini-'],
      provider: 'gemini',
      contextWindow: 1048576,
      maxOutput: 65536,
      capabilities: {
        tools: true,
        modalities: ['text', 'image', 'video'],
        thinkingStyle: 'extended',
      },
    },
  ],
});

test('Gemini non-stream maps contents, systemInstruction, generationConfig and usage', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    candidates: [
      { content: { role: 'model', parts: [{ text: 'Hello', thoughtSignature: 'resp-text-sig' }] }, finishReason: 'STOP' },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 3,
    },
  }));
  t.after(() => mock.close());
  const llm = createLLM(geminiConfig(mock.url));

  const result = await llm.chat({
    model: 'gemini-4-argon',
    system: 'be terse',
    systemSuffix: 'tail',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: 'AAAA', mediaType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'previous', signature: 'prev-sig' }],
        toolCalls: [{ id: 'c1', name: 'clock', input: { tz: 'UTC' }, signature: 'sig-1', providerId: 'fc-1' }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'clock', content: '{"ok":true}' },
    ],
    tools: [
      { name: 'clock', description: 'time', parameters: { type: 'object' } },
      { name: 'nodesc', parameters: { type: 'object' } },
    ],
    maxTokens: 2048,
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    stop: ['END'],
    seed: 7,
    jsonMode: true,
    thinking: 'enabled',
    thinkingBudgetTokens: 1024,
    extra: { generationConfig: { candidateCount: 2 } },
  });

  const request = mock.captured[0];
  assert.match(request.path, /\/v1beta\/models\/gemini-4-argon:generateContent$/);
  assert.equal(request.headers['x-goog-api-key'], 'gemini-key');
  assert.equal(request.headers.authorization, undefined);
  const body = request.body;
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be terse' }, { text: 'tail' }] });
  assert.equal(body.contents[0].role, 'user');
  assert.deepEqual(body.contents[0].parts[0], { text: 'look' });
  assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  assert.equal(body.contents[1].role, 'model');
  assert.deepEqual(body.contents[1].parts[0], { text: 'previous', thoughtSignature: 'prev-sig' });
  assert.deepEqual(body.contents[1].parts[1], {
    functionCall: { id: 'fc-1', name: 'clock', args: { tz: 'UTC' } },
    thoughtSignature: 'sig-1',
  });
  assert.deepEqual(body.contents[2], {
    role: 'user',
    parts: [{ functionResponse: { id: 'fc-1', name: 'clock', response: { ok: true } } }],
  });
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 2048,
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    stopSequences: ['END'],
    seed: 7,
    responseMimeType: 'application/json',
    thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
    candidateCount: 2,
  });
  assert.deepEqual(body.tools[0].functionDeclarations[0], {
    name: 'clock',
    description: 'time',
    parameters: { type: 'object' },
  });
  assert.equal(body.tools[0].functionDeclarations[1].name, 'nodesc');
  assert.equal(body.tools[0].functionDeclarations[1].description, '');
  assert.equal(body.stream, undefined);
  assert.equal(result.text, 'Hello');
  assert.equal(result.textSignature, 'resp-text-sig');
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 6);
  assert.equal(result.usage.cacheRead, 3);
  assert.equal(result.stopReason, 'end_turn');
});

test('Gemini stream maps thought/text deltas, tool signature and stop reason', async (t) => {
  const mock = await startMock(({ res }) => sendSse(res, [
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'plan', thought: true, thoughtSignature: 'think-sig' }] } }] } },
    { data: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] } },
    { data: { candidates: [{ content: { parts: [{ text: 'lo', thoughtSignature: 'text-sig' }] } }] } },
    { data: { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'empty-sig' }] } }] } },
    {
      data: {
        candidates: [
          {
            content: { parts: [{ functionCall: { id: 'fc-s', name: 'clock', args: { tz: 'UTC' } }, thoughtSignature: 'call-sig' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 1 },
      },
    },
  ]));
  t.after(() => mock.close());
  const llm = createLLM(geminiConfig(mock.url));

  const events = [];
  for await (const event of llm.chatStream({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'x' }] })) {
    events.push(event);
  }
  assert.match(mock.captured[0].path, /:streamGenerateContent\?alt=sse$/);
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'Hello');
  assert.equal(events.filter((e) => e.type === 'thinking_delta').map((e) => e.text).join(''), 'plan');
  const thinkingEnd = events.find((e) => e.type === 'thinking_end');
  assert.equal(thinkingEnd.signature, 'think-sig');
  const textEnd = events.find((e) => e.type === 'text_end');
  assert.equal(textEnd.signature, 'empty-sig');
  const call = events.find((e) => e.type === 'tool_call');
  assert.equal(call.name, 'clock');
  assert.deepEqual(call.input, { tz: 'UTC' });
  assert.equal(call.signature, 'call-sig');
  assert.equal(call.providerId, 'fc-s');
  const usage = events.find((e) => e.type === 'usage');
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.outputTokens, 4);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).stopReason, 'tool_use');
});

test('Gemini function call ids and thought signatures round-trip', async (t) => {
  let calls = 0;
  const mock = await startMock(({ res }) => {
    calls += 1;
    if (calls === 1) {
      sendJson(res, {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'fc-1', name: 'clock', args: { tz: 'UTC' } },
                  thoughtSignature: 'call-sig',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
      });
      return;
    }
    sendJson(res, {
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    });
  });
  t.after(() => mock.close());
  const llm = createLLM(geminiConfig(mock.url));
  const first = await llm.chat({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'time?' }] });
  assert.equal(first.toolCalls[0].id, 'fc-1');
  assert.equal(first.toolCalls[0].providerId, 'fc-1');
  assert.equal(first.toolCalls[0].signature, 'call-sig');

  await llm.chat({
    model: 'gemini-4-argon',
    messages: [
      { role: 'user', content: 'time?' },
      { role: 'assistant', toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: 'fc-1', name: 'clock', content: '{"ok":true}' },
    ],
  });
  const body = mock.captured[1].body;
  assert.deepEqual(body.contents[1].parts[0], {
    functionCall: { id: 'fc-1', name: 'clock', args: { tz: 'UTC' } },
    thoughtSignature: 'call-sig',
  });
  assert.deepEqual(body.contents[2].parts[0], {
    functionResponse: { id: 'fc-1', name: 'clock', response: { ok: true } },
  });
});

test('Gemini blocked prompts finish as refusal instead of an empty-response error', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    promptFeedback: { blockReason: 'SAFETY' },
    usageMetadata: { promptTokenCount: 2 },
  }));
  t.after(() => mock.close());
  const llm = createLLM(geminiConfig(mock.url));
  const result = await llm.chat({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.text, '');
  assert.equal(result.stopReason, 'refusal');
});

test('Gemini rawBody and path placeholders are preserved', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  }));
  t.after(() => mock.close());
  const config = geminiConfig(mock.url);
  config.providers[0].path = '/proxy/{model}:{method}';
  config.providers[0].query = { tenant: 'acme' };
  const llm = createLLM(config);
  const rawBody = { contents: [{ role: 'user', parts: [{ text: 'raw' }] }], custom: true };
  await llm.chat({ model: 'gemini-4-argon', messages: [], rawBody });
  assert.match(mock.captured[0].path, /^\/v1beta\/proxy\/gemini-4-argon:generateContent\?tenant=acme$/);
  assert.deepEqual(mock.captured[0].body, rawBody);
});

test('Gemini config rejects unsupported capabilities and deferLoading at request time', async () => {
  const config = geminiConfig('http://127.0.0.1:1');
  config.providers[0].caching = 'explicit';
  config.families[0].capabilities = { deferLoading: true, thinkingStyle: 'enable_thinking' };
  const llm = createLLM(config);
  const diagnostics = llm.validate();
  assert.ok(diagnostics.some((d) => d.code === 'UNSUPPORTED_FEATURE' && d.path.includes('caching')));
  assert.ok(diagnostics.some((d) => d.code === 'UNSUPPORTED_FEATURE' && d.path.includes('deferLoading')));
  assert.ok(diagnostics.some((d) => d.code === 'UNSUPPORTED_FEATURE' && d.path.includes('thinkingStyle')));

  const clean = createLLM(geminiConfig('http://127.0.0.1:1'));
  await assert.rejects(
    () => clean.chat({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'a', parameters: { type: 'object' } }],
      deferredTools: ['a'],
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /延迟加载/.test(error.message),
  );
  await assert.rejects(
    () => clean.chat({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'x' }], serverWebSearch: true }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /serverWebSearch/.test(error.message),
  );
  await assert.rejects(
    () => clean.chat({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'x' }],
      extra: { toolConfig: { functionCallingConfig: { streamFunctionCallArguments: true } } },
    }),
    (error) => error.code === 'UNSUPPORTED_FEATURE' && /streamFunctionCallArguments/.test(error.message),
  );

  const effortOnly = geminiConfig('http://127.0.0.1:1');
  effortOnly.families[0].capabilities = { thinkingStyle: 'effort_only' };
  const effortLlm = createLLM(effortOnly);
  await assert.rejects(
    () => effortLlm.chat({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'x' }], thinking: 'disabled' }),
    (error) => error.code === 'INVALID_REQUEST' && /effort_only/.test(error.message),
  );
});

test('Gemini discovery reads native model metadata', async (t) => {
  const mock = await startMock(({ req, res }) => {
    assert.equal(req.method, 'GET');
    sendJson(res, {
      models: [
        {
          name: 'models/gemini-4-argon',
          displayName: 'Gemini 4 Argon',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
        },
      ],
    });
  });
  t.after(() => mock.close());
  const llm = createLLM(geminiConfig(mock.url));
  const candidates = await llm.discover('gemini');
  assert.deepEqual(candidates, [
    {
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      contextWindow: 1048576,
      maxOutput: 65536,
    },
  ]);
  assert.equal(mock.captured[0].headers['x-goog-api-key'], 'gemini-key');
});

test('Gemini compat.systemPrompt=message and effort_only thinking are config-driven', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, {
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  }));
  t.after(() => mock.close());
  const config = geminiConfig(mock.url);
  config.families[0].compat = { systemPrompt: 'message' };
  config.families[0].capabilities = { tools: true, thinkingStyle: 'effort_only' };
  const llm = createLLM(config);
  await llm.chat({
    model: 'gemini-4-argon',
    system: 'be terse',
    messages: [{ role: 'user', content: 'x' }],
    effort: 'high',
    thinkingBudgetTokens: 999,
  });
  const body = mock.captured[0].body;
  assert.equal(body.systemInstruction, undefined);
  assert.deepEqual(body.contents[0].parts, [{ text: 'be terse' }, { text: 'x' }]);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
});
