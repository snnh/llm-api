import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLLM, loadConfig } from '../dist/index.js';
import { baseConfig, sendJson, startMock } from './helpers/mock.mjs';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'llm-api-store-'));

test('apply is transactional and keeps the previous configuration on failure', () => {
  const llm = createLLM(baseConfig('http://127.0.0.1:1'));
  const before = llm.model('claude-1').contextWindow;
  const broken = baseConfig('http://127.0.0.1:1');
  broken.providers[1].interfaceType = 'nope';
  const result = llm.apply(broken);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.severity === 'error'));
  assert.equal(llm.model('claude-1').contextWindow, before);
});

test('apply reports added, removed and updated entries', () => {
  const llm = createLLM(baseConfig('http://127.0.0.1:1'));
  const changes = [];
  llm.onConfigChange((event) => changes.push(event));
  const next = baseConfig('http://127.0.0.1:1');
  next.families[0].contextWindow = 64000;
  next.models = [{ id: 'chat-extra', provider: 'mock-chat', family: 'chat' }];
  const result = llm.apply(next);
  assert.equal(result.ok, true);
  assert.ok(result.changed.includes('families:chat:update'));
  assert.ok(result.changed.includes('models:chat-extra:add'));
  assert.ok(changes[0].families.includes('families:chat:update'));
});

test('save round-trips secrets and unknown fields, and loadConfig reads YAML and JSON', async () => {
  const dir = tempDir();
  const yamlFile = path.join(dir, 'config.yaml');
  writeFileSync(yamlFile, 'version: 1\nproviders: []\n');
  const config = baseConfig('http://127.0.0.1:1');
  config.providers[0].apiKey = 'sk-1234567890abcdef';
  config.providers[0].futureField = { keep: true };
  const llm = createLLM(config, { source: yamlFile });
  await llm.save();
  const text = readFileSync(yamlFile, 'utf8');
  assert.ok(text.includes('sk-1234567890abcdef'));
  assert.ok(text.includes('futureField'));
  const reloaded = loadConfig(yamlFile);
  assert.equal(reloaded.providers[0].apiKey, 'sk-1234567890abcdef');
  assert.deepEqual(reloaded.providers[0].futureField, { keep: true });

  const jsonFile = path.join(dir, 'config.json');
  writeFileSync(jsonFile, JSON.stringify(config));
  const fromJson = loadConfig(jsonFile);
  assert.equal(fromJson.providers[0].id, 'mock-chat');
});

test('validate reports the failing path without touching live state', () => {
  const llm = createLLM(baseConfig('http://127.0.0.1:1'));
  const diagnostics = llm.validate({
    ...baseConfig('http://127.0.0.1:1'),
    providers: [{ id: 'bad', interfaceType: 'openai-chat-completions', baseUrl: 'ftp://nope' }],
  });
  assert.ok(diagnostics.some((d) => d.path === 'providers[0].baseUrl' && d.code === 'INVALID_URL'));
  assert.ok(diagnostics.some((d) => d.severity === 'error'));
});

test('describe exposes a masked copy, schema is usable by a form generator', () => {
  const config = baseConfig('http://127.0.0.1:1');
  config.providers[0].apiKey = 'sk-abcdefghijklmnop';
  const llm = createLLM(config);
  const described = llm.describe();
  assert.match(described.providers[0].apiKey, /…/);
  const schema = llm.schema;
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.providers);
});

test('discover reads candidates and never writes them into the configuration', async (t) => {
  const mock = await startMock(({ res, req }) => {
    if (req.url.endsWith('/models')) {
      sendJson(res, { data: [{ id: 'm-1', context_window: 1000, max_tokens: 100 }, { id: 'm-2' }] });
      return;
    }
    sendJson(res, {});
  });
  t.after(() => mock.close());
  const llm = createLLM(baseConfig(mock.url));
  const before = JSON.stringify(llm.describe());
  const candidates = await llm.discover('mock-chat');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].id, 'm-1');
  assert.equal(candidates[0].contextWindow, 1000);
  assert.equal(JSON.stringify(llm.describe()), before);
  assert.equal(mock.captured[0].method, 'GET');
  assert.equal(mock.captured[0].headers.authorization, 'Bearer test-key');
});

test('discover honours a custom readPath', async (t) => {
  const mock = await startMock(({ res }) => sendJson(res, { result: { items: [{ model: 'x-1' }, { model: 'x-2' }] } }));
  t.after(() => mock.close());
  const config = baseConfig(mock.url);
  config.providers[0].discover = { path: '/custom', readPath: '$.result.items[*].model' };
  const llm = createLLM(config);
  const candidates = await llm.discover('mock-chat');
  assert.deepEqual(candidates.map((c) => c.id), ['x-1', 'x-2']);
});
