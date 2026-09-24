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
                  message: { content: source },
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
  assert.equal((await (await request('generate', payload)).json()).code, 'incomplete');
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
