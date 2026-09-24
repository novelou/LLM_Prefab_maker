import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { defaults, normalizeBaseUrl, validateSettings } from '../shared/config.mjs';
import { extractSource, executableSource } from '../shared/source.mjs';
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
                  message: { content: source, reasoning_content: mode === 'length' ? 'thinking so far' : '' },
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
  let observed;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ choices: [{ delta: { reasoning_content: 'thinking so far' } }] });
    emit({ choices: [{ delta: { content: source.slice(0, 30) } }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    emit({ choices: [{ delta: { content: source.slice(30) }, finish_reason: finishReason }] });
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
  await request('settings', {
    ...defaults,
    baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
    model: 'test-qwen',
  }, 'PUT');
  async function events() {
    const response = await request('generate', { prompt: 'cube', seed: 42, streamOutput: true });
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
  assert.deepEqual(success.map((event) => event.type), ['start', 'delta', 'delta', 'delta', 'result']);
  assert.equal(success.at(-1).source, source);
  assert.equal(success.at(-1).usage.total_tokens, 12);
  finishReason = 'length';
  const failed = await events();
  assert.equal(failed.at(-1).type, 'error');
  assert.equal(failed.at(-1).code, 'incomplete');
  assert.equal(failed.at(-1).details.output.text, source);
  assert.equal(failed.at(-1).details.reasoning.text, 'thinking so far');
  assert.equal(failed.at(-1).details.finishReason, 'length');
});
