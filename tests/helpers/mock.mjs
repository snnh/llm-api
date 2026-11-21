import http from 'node:http';

export async function startMock(handler) {
  const captured = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const record = { path: req.url, method: req.method, headers: req.headers, body, raw };
    captured.push(record);
    try {
      await handler({ req, res, body, record, index: captured.length - 1, captured });
    } catch (cause) {
      res.writeHead(500).end(String(cause));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    captured,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

export function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

export function sendSse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) {
    if (typeof frame === 'string') res.write(frame);
    else if (frame.event) res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
    else res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
  }
  res.end();
}

export const baseConfig = (url, overrides = {}) => ({
  version: 1,
  providers: [
    { id: 'mock-chat', interfaceType: 'openai-chat-completions', baseUrl: `${url}/v1`, apiKey: 'test-key' },
    { id: 'mock-anthropic', interfaceType: 'anthropic-messages', baseUrl: `${url}/v1`, apiKey: 'test-key' },
  ],
  families: [
    { id: 'chat', match: ['chat-'], provider: 'mock-chat', contextWindow: 128000, capabilities: { tools: true } },
    { id: 'claude', match: ['claude-'], provider: 'mock-anthropic', contextWindow: 200000, capabilities: { tools: true } },
  ],
  ...overrides,
});
