import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test.skip(!process.env.LIVE_EDIT_BASE_URL, 'Set LIVE_EDIT_BASE_URL to test a local model API.');

test('a real model revises a small change with line-scoped edits', async ({ page }) => {
  test.setTimeout(420000);
  const baseUrl = process.env.LIVE_EDIT_BASE_URL!;
  const models = await (await fetch(baseUrl + '/models')).json();
  const modelId = models.data?.[0]?.id;
  expect(modelId).toBeTruthy();

  const original = [
    'function createModel({ THREE }) {',
    '  const modelRoot = new THREE.Group();',
    '  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff0000 }));',
    '  mesh.position.y = 0.5;',
    '  modelRoot.add(mesh);',
    '  return { modelRoot };',
    '}',
  ].join('\n');
  let calls = 0;
  await page.route('**/api/generate', async (route) => {
    calls++;
    if (calls === 1)
      await route.fulfill({ json: { source: original, model: modelId, elapsedMs: 1 } });
    else await route.continue();
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: '接続テスト', exact: true })).toBeEnabled();
  await page.getByLabel('Base URL').fill(baseUrl);
  await page.getByLabel('Model ID').fill(modelId);
  await page.getByLabel('モデルの説明・追加指示').fill('赤い立方体を作ってください。');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();

  await page
    .getByLabel('モデルの説明・追加指示')
    .fill('立方体の色だけ青に変更し、形状と位置は維持してください。');
  await page.getByRole('button', { name: '追加指示で修正', exact: true }).click();
  await expect(page.locator('.history-list>button')).toHaveCount(2, { timeout: 360000 });
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  const raw = await page
    .locator('.trace-attempt')
    .last()
    .locator('.trace-text pre')
    .first()
    .textContent();
  expect(raw).toBeTruthy();
  const response = JSON.parse(
    raw!
      .trim()
      .replace(/^```json\s*\n/, '')
      .replace(/```$/, ''),
  );
  expect(response.mode).toBe('edits');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'プロジェクト保存', exact: true }).click(),
  ]);
  const archive = unzipSync(new Uint8Array(await readFile(await download.path())));
  const savedSource = strFromU8(archive['sources/1.js']);
  expect(savedSource).toContain('new THREE.BoxGeometry(1, 1, 1)');
  expect(savedSource).toContain('mesh.position.y = 0.5;');
  expect(savedSource).not.toContain('color: 0xff0000');
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(calls).toBeLessThanOrEqual(4);
});
