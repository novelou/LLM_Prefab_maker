import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { defaults, normalizeBaseUrl, validateSettings } from '../shared/config.mjs';
import {
  extractRepairSource,
  extractSource,
  executableSource,
  numberedSource,
} from '../shared/source.mjs';
import { messagesFor } from '../server/prompt.mjs';
const source = 'function createModel({ THREE }) { return { modelRoot: new THREE.Group() }; }';
test('URL normalization preserves proxy paths and rejects credential URLs', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000/v1');
  assert.equal(
    normalizeBaseUrl('http://localhost:9000/proxy/v1/chat/completions'),
    'http://localhost:9000/proxy/v1',
  );
  assert.throws(() => normalizeBaseUrl('http://user:secret@localhost'));
  assert.throws(() => validateSettings({ maxTokens: NaN }));
  assert.throws(() => validateSettings({ runtimeSeconds: 0 }));
  for (const effort of ['default', 'none', 'low', 'medium', 'xhigh'])
    assert.equal(validateSettings({ reasoningEffort: effort }).reasoningEffort, effort);
  assert.throws(() => validateSettings({ reasoningEffort: 'high' }));
});
test('only complete source is accepted; no partial execution', () => {
  assert.equal(extractSource('```javascript\n' + source + '\n```', 'stop'), source);
  assert.throws(() => extractSource(source, 'length'), { code: 'incomplete' });
  assert.throws(() => extractSource(source, undefined), { code: 'incomplete' });
  assert.throws(() => extractSource('some text', 'stop'), { code: 'contract' });
  const arrow = 'export const createModel = ({ THREE }) => ({ modelRoot: new THREE.Group() });';
  assert.equal(extractSource(arrow, 'stop'), arrow);
  assert.equal(executableSource(arrow).startsWith('const createModel'), true);
});
test('line-scoped repair edits only the requested duplicate and rejects stale ranges', () => {
  const repeated = [
    'function createModel({ THREE }) {',
    '  const modelRoot = new THREE.Group();',
    "  modelRoot.name = 'same';",
    "  modelRoot.name = 'same';",
    '  return { modelRoot };',
    '}',
  ].join('\n');
  assert.match(numberedSource(repeated), /^4\|  modelRoot\.name = 'same';$/m);
  const patch = (edits) => JSON.stringify({ mode: 'edits', edits });
  const edit = {
    startLine: 4,
    old: "  modelRoot.name = 'same';",
    new: "  modelRoot.name = 'fixed';",
  };
  const repaired = extractRepairSource(patch([edit]), 'stop', repeated);
  assert.equal(repaired.split('\n')[2], "  modelRoot.name = 'same';");
  assert.equal(repaired.split('\n')[3], "  modelRoot.name = 'fixed';");
  assert.throws(() => extractRepairSource(patch([{ ...edit, startLine: 2 }]), 'stop', repeated), {
    code: 'patch',
  });
  assert.throws(() => extractRepairSource(patch([edit, edit]), 'stop', repeated), {
    code: 'patch',
  });
  assert.throws(() => extractRepairSource('[{"mode":"edits"}]', 'stop', repeated), {
    code: 'patch',
  });
  assert.throws(() => extractRepairSource('{"mode":"edits",', 'stop', repeated), {
    code: 'patch',
  });
  const twoEdits = extractRepairSource(
    patch([
      {
        startLine: 4,
        old: "  modelRoot.name = 'same';",
        new: "  modelRoot.name = 'fixed';\n  modelRoot.userData.ok = true;",
      },
      { startLine: 5, old: '  return { modelRoot };', new: '  return { modelRoot, preview: {} };' },
    ]),
    'stop',
    repeated,
  );
  assert.equal(twoEdits.split('\n')[4], '  modelRoot.userData.ok = true;');
  assert.equal(twoEdits.split('\n')[5], '  return { modelRoot, preview: {} };');
  assert.throws(() => extractRepairSource(patch([edit]), 'length', repeated), {
    code: 'incomplete',
  });
  assert.equal(
    extractRepairSource(JSON.stringify({ mode: 'source', source: repeated }), 'stop', repeated),
    repeated,
  );
  assert.equal(extractRepairSource(repeated, 'stop', repeated), repeated);
  const repairPrompt = messagesFor({
    prompt: 'a model',
    source: repeated,
    error: 'broken',
    seed: 1,
  });
  assert.match(repairPrompt[1].content, /4\|  modelRoot\.name = 'same';/);
  assert.match(repairPrompt[1].content, /startLine/);
});

test('repair API materializes line edits before returning source', async (t) => {
  const original = [
    'function createModel({ THREE }) {',
    '  const modelRoot = new THREE.Group();',
    "  modelRoot.name = 'same';",
    "  modelRoot.name = 'same';",
    '  return { modelRoot };',
    '}',
  ].join('\n');
  let observed;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: 'edits',
                edits: [
                  {
                    startLine: 4,
                    old: "  modelRoot.name = 'same';",
                    new: "  modelRoot.name = 'fixed';",
                  },
                ],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, persist: false });
  t.after(() => {
    app.closeAllConnections();
    app.close();
    fake.closeAllConnections();
    fake.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const { token } = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Session-Token': token };
  await fetch(base + '/api/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ...defaults,
      baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
      model: 'test-qwen',
    }),
  });
  const response = await fetch(base + '/api/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'cube', source: original, error: 'broken', seed: 42 }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.source.split('\n')[2], "  modelRoot.name = 'same';");
  assert.equal(result.source.split('\n')[3], "  modelRoot.name = 'fixed';");
  assert.match(observed.messages[1].content, /4\|  modelRoot\.name = 'same';/);
});
test('selected reasoning effort reaches generation requests', async (t) => {
  let observed;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: source }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, persist: false });
  t.after(() => {
    app.closeAllConnections();
    app.close();
    fake.closeAllConnections();
    fake.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const { token } = await (await fetch(base + '/api/session')).json();
  const request = (path, data, method = 'POST') =>
    fetch(`${base}/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify(data),
    });
  const config = {
    ...defaults,
    baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
    model: 'test-qwen',
  };
  for (const effort of ['default', 'none', 'low', 'medium', 'xhigh']) {
    const saved = await request('settings', { ...config, reasoningEffort: effort }, 'PUT');
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).settings.reasoningEffort, effort);
    assert.equal((await request('generate', { prompt: 'make a cube', seed: 42 })).status, 200);
    assert.deepEqual(
      observed.chat_template_kwargs,
      effort === 'default' ? undefined : { reasoning_effort: effort },
    );
  }
});
test('local API: auth, origin, settings, errors, concurrency and cancellation', async (t) => {
  let mode = 'ok',
    observedKey,
    requests = 0;
  const fake = http.createServer(async (req, res) => {
    observedKey = req.headers.authorization;
    requests++;
    for await (const _ of req) {
      /* drain */
    }
    if (mode === 'slow') {
      setTimeout(() => {
        if (!res.destroyed) res.end('{}');
      }, 800);
      return;
    }
    if (mode === 'timeout') return;
    if (mode === 'malformed') {
      res.end('{"choices":[');
      return;
    }
    if (mode === 'oversized') {
      res.end('x'.repeat(4 * 1024 * 1024 + 1));
      return;
    }
    if (mode === '401' || mode === '429') {
      res.writeHead(Number(mode));
      res.end('upstream sensitive body must not leak');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/v1/models'
          ? { data: [{ id: 'test-qwen' }] }
          : {
              choices: [
                {
                  message: {
                    content: source,
                    reasoning_content: mode === 'length' ? 'thinking so far' : '',
                  },
                  finish_reason: mode === 'length' ? 'length' : 'stop',
                },
              ],
              usage: { total_tokens: 10 },
            },
      ),
    );
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const app = await startServer({ port: 0, persist: false });
  t.after(() => {
    app.closeAllConnections();
    app.close();
    fake.closeAllConnections();
    fake.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  assert.match(session.promptHash, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
  assert.equal((await fetch(base + '/api/session')).status, 200);
  const request = (path, body = {}, headers = {}, method = 'POST') =>
    fetch(base + '/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token, ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await request('models', {}, { 'X-Session-Token': '' })).status, 403);
  assert.equal((await request('models', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await request('models', {}, { Origin: 'null' })).status, 403);
  const badHost = await new Promise((yes, no) => {
    const req = http.get(base + '/api/session', { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      yes(res.statusCode);
    });
    req.on('error', no);
  });
  assert.equal(badHost, 403);
  const config = {
    ...defaults,
    baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
    model: 'test-qwen',
  };
  assert.equal((await request('settings', config, {}, 'PUT')).status, 200);
  assert.equal((await request('models')).status, 200);
  assert.equal(observedKey, undefined);
  const saved = await (
    await request('settings', { ...config, apiKey: 'session-test-key' }, {}, 'PUT')
  ).json();
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes('session-test-key'), false);
  await request('models');
  assert.equal(observedKey, 'Bearer session-test-key');
  assert.equal(
    JSON.stringify(await (await fetch(base + '/api/session')).json()).includes('session-test-key'),
    false,
  );
  const payload = { prompt: 'make a cube', seed: 42 };
  assert.equal((await (await request('generate', payload)).json()).source, source);
  mode = 'length';
  const incomplete = await (await request('generate', payload)).json();
  assert.equal(incomplete.code, 'incomplete');
  assert.equal(incomplete.details.output.text, source);
  assert.equal(incomplete.details.reasoning.text, 'thinking so far');
  assert.equal(incomplete.details.finishReason, 'length');
  for (const status of ['401', '429']) {
    mode = status;
    const res = await request('generate', payload);
    assert.equal(res.status, Number(status));
    assert.equal((await res.text()).includes('sensitive body'), false);
  }
  mode = 'slow';
  const first = request('generate', payload);
  while (requests < 7) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal((await request('generate', payload)).status, 409);
  assert.equal((await request('settings', config, {}, 'PUT')).status, 409);
  await request('cancel');
  assert.equal((await (await first).json()).code, 'cancelled');
  mode = 'ok';
  assert.equal((await request('generate', payload)).status, 200);
  mode = 'malformed';
  assert.equal((await (await request('generate', payload)).json()).code, 'protocol');
  mode = 'oversized';
  assert.equal((await (await request('generate', payload)).json()).code, 'budget');
  await request('settings', { ...config, timeoutSeconds: 5 }, {}, 'PUT');
  mode = 'timeout';
  const timeoutResponse = await request('generate', payload);
  assert.equal(timeoutResponse.status, 504);
  assert.equal((await timeoutResponse.json()).code, 'timeout');
  mode = 'ok';
  assert.equal((await request('generate', payload)).status, 200);
});

test('streamed generation emits text before completion and keeps partial output on failure', async (t) => {
  let finishReason = 'stop';
  let content = source;
  let observed;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ choices: [{ delta: { reasoning_content: 'thinking so far' } }] });
    emit({ choices: [{ delta: { content: content.slice(0, 30) } }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    emit({ choices: [{ delta: { content: content.slice(30) }, finish_reason: finishReason }] });
    emit({ choices: [], usage: { total_tokens: 12 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, persist: false });
  t.after(() => {
    app.closeAllConnections();
    app.close();
    fake.closeAllConnections();
    fake.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const { token } = await (await fetch(base + '/api/session')).json();
  const request = (path, data, method = 'POST') =>
    fetch(`${base}/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify(data),
    });
  await request(
    'settings',
    {
      ...defaults,
      baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
      model: 'test-qwen',
    },
    'PUT',
  );
  async function events(payload = {}) {
    const response = await request('generate', {
      prompt: 'cube',
      seed: 42,
      streamOutput: true,
      ...payload,
    });
    assert.match(response.headers.get('content-type'), /ndjson/);
    const found = [];
    let buffer = '';
    for await (const bytes of response.body) {
      buffer += Buffer.from(bytes).toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        found.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    }
    assert.equal(buffer, '');
    return found;
  }
  const success = await events();
  assert.equal(observed.stream, true);
  assert.equal(observed.stream_options.include_usage, true);
  assert.deepEqual(
    success.map((event) => event.type),
    ['start', 'delta', 'delta', 'delta', 'result'],
  );
  assert.equal(success.at(-1).source, source);
  assert.equal(success.at(-1).usage.total_tokens, 12);
  const original = [
    'function createModel({ THREE }) {',
    '  const modelRoot = new THREE.Group();',
    "  modelRoot.name = 'same';",
    "  modelRoot.name = 'same';",
    '  return { modelRoot };',
    '}',
  ].join('\n');
  content = JSON.stringify({
    mode: 'edits',
    edits: [
      { startLine: 4, old: "  modelRoot.name = 'same';", new: "  modelRoot.name = 'fixed';" },
    ],
  });
  const repair = await events({ source: original, error: 'broken' });
  assert.equal(repair.at(-1).type, 'result');
  assert.equal(repair.at(-1).source.split('\n')[2], "  modelRoot.name = 'same';");
  assert.equal(repair.at(-1).source.split('\n')[3], "  modelRoot.name = 'fixed';");
  assert.match(observed.messages[1].content, /4\|  modelRoot\.name = 'same';/);
  content = source;
  finishReason = 'length';
  const failed = await events();
  assert.equal(failed.at(-1).type, 'error');
  assert.equal(failed.at(-1).code, 'incomplete');
  assert.equal(failed.at(-1).details.output.text, source);
  assert.equal(failed.at(-1).details.reasoning.text, 'thinking so far');
  assert.equal(failed.at(-1).details.finishReason, 'length');
});
