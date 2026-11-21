#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createLLM, loadConfig } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const configPath = flag('--config', path.join(here, 'llm-api.config.yaml'));
const model = flag('--model', 'deepseek-reasoner');
const prompt = flag('--prompt', '用一句话说明你是什么模型。');

let config;
try {
  config = loadConfig(configPath);
} catch (error) {
  console.error(`读取配置失败：${error.message}`);
  process.exit(1);
}

const llm = createLLM(config, { source: configPath });

const view = llm.model(model);
if (!view) {
  console.error(`模型未命中：${model}`);
  console.error('可用模型：', llm.models().map((m) => m.id).join(', ') || '(仅家族配置，可写 provider/model)');
  process.exit(1);
}
if (view.state === 'error') {
  console.error('配置有问题：', view.diagnostics);
  process.exit(1);
}

console.log(`端点：${view.provider}  协议：${view.interfaceType}  线上模型：${view.upstream}`);
console.log(`上下文：${view.contextWindow}  输出上限：${view.maxOutput}  缓存：${view.caching}\n`);

try {
  const stream = llm.chatStream({ model, messages: [{ role: 'user', content: prompt }] });
  for await (const event of stream) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'thinking_delta':
        process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
        break;
      case 'tool_call':
        process.stdout.write(`\n[tool] ${event.name} ${JSON.stringify(event.input)}\n`);
        break;
      case 'usage':
        process.stdout.write(`\n\n[usage] in=${event.inputTokens} out=${event.outputTokens} cacheRead=${event.cacheRead} cacheWrite=${event.cacheWrite}\n`);
        break;
      case 'error':
        console.error('\n请求失败：', event.error.code, event.error.message);
        process.exitCode = 1;
        break;
      default:
        break;
    }
  }
} catch (error) {
  console.error(`\n请求失败：${error.code ?? ''} ${error.message}`);
  if (error.code === 'MISSING_CREDENTIAL') console.error('提示：先在环境里导出 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY。');
  process.exitCode = 1;
}
