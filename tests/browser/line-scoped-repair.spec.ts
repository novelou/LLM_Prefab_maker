import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test('line-scoped repair changes only the selected duplicate and rejects a stale edit', async ({
  page,
}) => {
  const broken = [
    'function createModel({ THREE }) {',
    '  const modelRoot = new THREE.Group();',
    '  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff4444 }));',
    '  mesh.position.y = 0.5;',
    '  mesh.position.y = 0.5;',
    "  if (mesh.position.y === 0.5) throw new Error('deliberate failure');",
    '  modelRoot.add(mesh);',
    '  return { modelRoot };',
    '}',
  ].join('\n');
  const edit = (old: string) =>
    JSON.stringify({
      mode: 'edits',
      edits: [{ startLine: 5, old, new: '  mesh.position.y = 0.6;' }],
    });
  const replies = [
    broken,
    edit('  mesh.position.y = 0.5;'),
    broken,
    edit('  mesh.position.y = 0.6;'),
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
    await expect(page.getByRole('button', { name: 'モデルを生成', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();

    await expect(page.locator('.message.success')).toContainText('自動修復');
    await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[1].content).toContain('4|  mesh.position.y = 0.5;');
    expect(requests[1].messages[1].content).toContain('5|  mesh.position.y = 0.5;');
    expect(requests[1].messages[1].content).toContain('deliberate failure');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'プロジェクト保存', exact: true }).click(),
    ]);
    const archive = unzipSync(new Uint8Array(await readFile(await download.path())));
    const savedSource = strFromU8(archive['sources/0.js']).split('\n');
    expect(savedSource[3]).toBe('  mesh.position.y = 0.5;');
    expect(savedSource[4]).toBe('  mesh.position.y = 0.6;');
    expect(JSON.parse(strFromU8(archive['project.json'])).versions[0].repaired).toBe(true);

    await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('元コードと一致しません');
    expect(requests).toHaveLength(4);
    await expect(page.locator('.history-list>button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  } finally {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
