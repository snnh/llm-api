#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createLLM, loadConfig } from '../../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const configPath = flag('--config', path.join(here, '../llm-api.config.yaml'));
const port = Number(flag('--port', '8788'));

let raw;
try {
  raw = loadConfig(configPath);
} catch (error) {
  console.error(`无法读取 ${configPath}：${error.message}`);
  process.exit(1);
}
const llm = createLLM(raw, { source: configPath });

const MASK = /…|^•+$/;
function keepMasked(current, incoming) {
  if (incoming === undefined) return current;
  return typeof incoming === 'string' && MASK.test(incoming) ? current : incoming;
}

/** Merge masked secrets from the live config back into a candidate edited in the browser. */
function restoreSecrets(current, candidate) {
  const next = structuredClone(candidate);
  for (const provider of next.providers ?? []) {
    const previous = (current.providers ?? []).find((item) => item.id === provider.id);
    if (!previous) continue;
    provider.apiKey = keepMasked(previous.apiKey, provider.apiKey);
    if (provider.apiKey === undefined) delete provider.apiKey;
    if (provider.headers && previous.headers) {
      for (const key of Object.keys(provider.headers)) {
        if (MASK.test(String(provider.headers[key]))) provider.headers[key] = previous.headers[key];
      }
    }
  }
  return next;
}

const json = (res, value, status = 200) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname];
      const body = await readFile(path.join(here, 'public', file));
      res.writeHead(200, { 'content-type': type });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, {
        configPath,
        config: llm.describe(),
        schema: llm.schema,
        models: llm.models(),
        providers: llm.providers(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/validate') {
      const body = await readBody(req);
      const merged = restoreSecrets(raw, body.config);
      json(res, { diagnostics: llm.validate(merged) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/apply') {
      const body = await readBody(req);
      const merged = restoreSecrets(raw, body.config);
      const result = llm.apply(merged);
      if (result.ok) raw = merged;
      json(res, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/save') {
      await llm.save();
      json(res, { ok: true, configPath });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/discover') {
      const provider = url.searchParams.get('provider');
      json(res, { candidates: await llm.discover(provider) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const request = {
        model: body.model,
        ...(body.system ? { system: body.system } : {}),
        messages: [{ role: 'user', content: body.prompt ?? '' }],
        ...(body.maxTokens ? { maxTokens: Number(body.maxTokens) } : {}),
        ...(body.thinking ? { thinking: body.thinking } : {}),
      };
      try {
        for await (const event of llm.chatStream(request)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: { code: error.code, message: error.message } })}\n\n`);
      }
      res.end();
      return;
    }
    res.writeHead(404).end('not found');
  } catch (error) {
    if (!res.headersSent) json(res, { error: error.message }, 500);
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`llm-api web reference: http://127.0.0.1:${port}`);
  console.log(`config: ${configPath}`);
});
