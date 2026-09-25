import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test('additional instructions use line edits, retry stale edits, and repair one compile failure', async ({
  page,
}) => {
  const original = [
    'function createModel({ THREE }) {',
    '  const modelRoot = new THREE.Group();',
    '  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());',
    '  mesh.position.y = 0.5;',
    '  mesh.position.y = 0.5;',
    '  modelRoot.add(mesh);',
    '  return { modelRoot };',
    '}',
  ].join('\n');
  const edit = (old: string, replacement: string) =>
    JSON.stringify({ mode: 'edits', edits: [{ startLine: 5, old, new: replacement }] });
  const replies = [
    original,
    edit('  mesh.position.y = 0.6;', '  mesh.position.y = 0.6;'),
    edit('  mesh.position.y = 0.5;', '  mesh.position.y = 0.6;'),
    edit('  mesh.position.y = 0.6;', '  mesh.position.y = ;'),
    edit('  mesh.position.y = ;', '  mesh.position.y = 0.7;'),
  ];
  const requests: any[] = [];
  const fake = http.createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const content = replies[requests.length - 1];
    if (!content) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 10 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  try {
    const port = (fake.address() as { port: number }).port;
    await page.goto('/');
    await expect(page.getByRole('button', { name: '接続テスト', exact: true })).toBeEnabled();
    await page.getByLabel('Base URL').fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('Model ID').fill('fixture');
    await page.getByLabel('モデルの説明・追加指示').fill('a cube');
    await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
    await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();

    await page.getByLabel('モデルの説明・追加指示').fill('raise only the second assignment');
    await page.getByRole('button', { name: '追加指示で修正', exact: true }).click();
    await expect(page.locator('.history-list>button')).toHaveCount(2);
    expect(requests).toHaveLength(3);
    expect(requests[1].messages[1].content).toContain('Revise this source');
    expect(requests[1].messages[1].content).toContain('4|  mesh.position.y = 0.5;');
    expect(requests[1].messages[1].content).toContain('5|  mesh.position.y = 0.5;');
    expect(requests[2].messages[1].content).toContain('前回の編集応答の失敗 (1/3)');
    expect(requests[2].messages[1].content).toContain('5|  mesh.position.y = 0.5;');

    await page.getByLabel('モデルの説明・追加指示').fill('raise the second assignment again');
    await page.getByRole('button', { name: '追加指示で修正', exact: true }).click();
    await expect(page.locator('.history-list>button')).toHaveCount(3);
    await expect(page.locator('.message.success')).toContainText('自動修復');
    expect(requests).toHaveLength(5);
    expect(requests[4].messages[1].content).toContain('Repair this source');
    expect(requests[4].messages[1].content).toContain('5|  mesh.position.y = ;');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'プロジェクト保存', exact: true }).click(),
    ]);
    const archive = unzipSync(new Uint8Array(await readFile(await download.path())));
    const firstRevision = strFromU8(archive['sources/1.js']).split('\n');
    const secondRevision = strFromU8(archive['sources/2.js']).split('\n');
    expect(firstRevision[3]).toBe('  mesh.position.y = 0.5;');
    expect(firstRevision[4]).toBe('  mesh.position.y = 0.6;');
    expect(secondRevision[3]).toBe('  mesh.position.y = 0.5;');
    expect(secondRevision[4]).toBe('  mesh.position.y = 0.7;');
    const versions = JSON.parse(strFromU8(archive['project.json'])).versions;
    expect(versions[1].repaired).toBe(false);
    expect(versions[2].repaired).toBe(true);
  } finally {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
