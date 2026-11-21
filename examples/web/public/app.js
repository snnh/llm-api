const $ = (id) => document.getElementById(id);
let editorDirty = false;

const tabs = document.querySelectorAll('.tabs button');
tabs.forEach((button) => button.addEventListener('click', () => {
  tabs.forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab));
}));

function setStatus(text, kind = 'muted') {
  $('status').textContent = text;
  $('status').style.color = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? 'var(--ok)' : 'var(--muted)';
}

function renderDiagnostics(diagnostics) {
  const list = $('diagnostics');
  list.innerHTML = '';
  if (!diagnostics.length) {
    const item = document.createElement('li');
    item.textContent = '没有问题';
    item.className = 'state-ok';
    list.append(item);
    return;
  }
  for (const diagnostic of diagnostics) {
    const item = document.createElement('li');
    item.className = diagnostic.severity;
    item.textContent = `${diagnostic.severity === 'error' ? '✕' : '!'} ${diagnostic.path || '(root)'} ${diagnostic.message}`;
    list.append(item);
  }
}

function renderModels(state) {
  const body = document.querySelector('#models-table tbody');
  body.innerHTML = '';
  const options = $('model-options');
  options.innerHTML = '';
  const rows = state.models.length ? state.models : [];
  for (const model of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${model.id}</td><td>${model.provider}</td><td>${model.interfaceType}</td><td>${model.contextWindow}</td><td>${model.source}</td><td class="${model.state === 'ok' ? 'state-ok' : 'state-error'}">${model.state}</td>`;
    body.append(tr);
    const option = document.createElement('option');
    option.value = model.id;
    options.append(option);
  }
  const select = $('discover-provider');
  select.innerHTML = '';
  for (const provider of state.providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${provider.id} · ${provider.interfaceType}`;
    select.append(option);
  }
  if (!state.models.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint">没有声明 models；可以直接用 provider/model 或家族命名的模型名。</td></tr>';
  }
  const families = $('families');
  families.innerHTML = '';
  for (const family of state.config.families ?? []) {
    const item = document.createElement('li');
    item.textContent = `${family.id} · ${(family.match ?? []).join(', ') || '无 match'} · ${family.provider ?? '未指定端点'}`;
    families.append(item);
  }
  if (!(state.config.families ?? []).length) families.innerHTML = '<li>没有家族</li>';
}

async function loadState() {
  const response = await fetch('/api/state');
  const state = await response.json();
  $('config-path').textContent = state.configPath;
  if (!editorDirty) $('editor').value = JSON.stringify(state.config, null, 2);
  renderModels(state);
  return state;
}

$('editor').addEventListener('input', () => { editorDirty = true; });

const readEditor = () => {
  try {
    return JSON.parse($('editor').value);
  } catch (error) {
    setStatus(`JSON 解析失败：${error.message}`, 'error');
    throw error;
  }
};

$('validate').addEventListener('click', async () => {
  try {
    const config = readEditor();
    const response = await fetch('/api/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config }) });
    const { diagnostics } = await response.json();
    renderDiagnostics(diagnostics);
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    setStatus(errors ? `${errors} 个错误` : '校验通过', errors ? 'error' : 'ok');
  } catch { /* status already set */ }
});

$('apply').addEventListener('click', async () => {
  try {
    const config = readEditor();
    const response = await fetch('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config }) });
    const result = await response.json();
    renderDiagnostics(result.diagnostics ?? []);
    if (result.ok) {
      setStatus(`已应用：${result.changed.join(', ') || '无变化'}`, 'ok');
      await loadState();
    } else {
      setStatus('应用失败，旧配置保持不变', 'error');
    }
  } catch { /* status already set */ }
});

$('save').addEventListener('click', async () => {
  const response = await fetch('/api/save', { method: 'POST' });
  const result = await response.json();
  setStatus(result.ok ? `已写回 ${result.configPath}` : '写回失败', result.ok ? 'ok' : 'error');
});

$('discover').addEventListener('click', async () => {
  const provider = $('discover-provider').value;
  const list = $('candidates');
  list.innerHTML = '<li>查询中…</li>';
  try {
    const response = await fetch(`/api/discover?provider=${encodeURIComponent(provider)}`);
    const { candidates } = await response.json();
    list.innerHTML = '';
    if (!candidates.length) list.innerHTML = '<li>没有候选</li>';
    for (const candidate of candidates) {
      const item = document.createElement('li');
      item.textContent = candidate.contextWindow ? `${candidate.id} · ${candidate.contextWindow}` : candidate.id;
      const adopt = document.createElement('button');
      adopt.textContent = '加入 models';
      adopt.style.marginLeft = '8px';
      adopt.addEventListener('click', () => {
        try {
          const config = JSON.parse($('editor').value);
          config.models = config.models ?? [];
          if (!config.models.some((model) => model.id === candidate.id)) {
            config.models.push({ id: candidate.id, provider });
            $('editor').value = JSON.stringify(config, null, 2);
            editorDirty = true;
            setStatus(`已加入草稿：${candidate.id}（记得校验并应用）`, 'ok');
          }
        } catch (error) {
          setStatus(`草稿不是合法 JSON：${error.message}`, 'error');
        }
      });
      item.append(adopt);
      list.append(item);
    }
  } catch (error) {
    list.innerHTML = `<li class="error">${error.message}</li>`;
  }
});

function appendLog(text, className = '') {
  const log = $('chat-log');
  if (!className) log.textContent += text;
  else {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    log.append(span);
  }
  log.scrollTop = log.scrollHeight;
}

$('clear').addEventListener('click', () => { $('chat-log').textContent = ''; });

$('send').addEventListener('click', async () => {
  const model = $('chat-model').value.trim();
  const prompt = $('chat-prompt').value;
  if (!model || !prompt) { setStatus('模型和 prompt 都要填', 'error'); return; }
  $('chat-log').textContent = '';
  const payload = {
    model,
    prompt,
    ...($('chat-system').value ? { system: $('chat-system').value } : {}),
    ...($('chat-max').value ? { maxTokens: Number($('chat-max').value) } : {}),
  };
  const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.replace(/^data: /, '').trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'text_delta') appendLog(event.text);
      else if (event.type === 'thinking_delta') appendLog(event.text, 'hint');
      else if (event.type === 'tool_call') appendLog(`\n[tool] ${event.name} ${JSON.stringify(event.input)}\n`, 'hint');
      else if (event.type === 'usage') appendLog(`\n[usage] in=${event.inputTokens} out=${event.outputTokens} cacheRead=${event.cacheRead} cacheWrite=${event.cacheWrite}\n`, 'hint');
      else if (event.type === 'error') appendLog(`\n[error] ${event.error.code} ${event.error.message}\n`, 'state-error');
      else if (event.type === 'done') appendLog(`\n[done] ${event.stopReason}\n`, 'hint');
    }
  }
});

await loadState();
