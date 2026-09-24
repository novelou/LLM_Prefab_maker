import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test.skip(
  !process.env.LIVE_REPAIR_BASE_URL,
  'Set LIVE_REPAIR_BASE_URL to run against a local model API.',
);

test('a real model repairs an injected runtime failure with line-scoped edits', async ({
  page,
}) => {
  test.setTimeout(420000);
  const baseUrl = process.env.LIVE_REPAIR_BASE_URL!;
  const models = await (await fetch(baseUrl + '/models')).json();
  const modelId = models.data?.[0]?.id;
  expect(modelId).toBeTruthy();

  const broken = [
    'function createModel({ THREE }) {',
    '  const modelRoot = new THREE.Group();',
    '  {',
    '    const radius = 0.35;',
    '    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), new THREE.MeshStandardMaterial({ color: 0xff4444 }));',
    '    mesh.position.y = radius;',
    '    mesh.position.x = -0.45;',
    '    modelRoot.add(mesh);',
    '  }',
    '  {',
    '    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0x4444ff }));',
    '    mesh.position.y = radius;',
    '    mesh.position.x = 0.45;',
    '    modelRoot.add(mesh);',
    '  }',
    '  return { modelRoot };',
    '}',
  ].join('\n');
  let calls = 0;
  await page.route('**/api/generate', async (route) => {
    calls++;
    if (calls === 1) {
      await route.fulfill({ json: { source: broken, model: modelId, elapsedMs: 1 } });
    } else {
      await route.continue();
    }
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: '接続テスト', exact: true })).toBeEnabled();
  await page.getByLabel('Base URL').fill(baseUrl);
  await page.getByLabel('Model ID').fill(modelId);
  await page
    .getByLabel('モデルの説明・追加指示')
    .fill(
      '赤い球（半径0.35m）と青い立方体（一辺0.4m）を地面に置いてください。球は維持し、実行エラーを修正してください。',
    );
  await expect(page.getByRole('button', { name: 'モデルを生成', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();

  await expect(page.locator('.message.success')).toContainText('自動修復', { timeout: 360000 });
  expect(calls).toBe(2);
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  const raw = await page
    .locator('.trace-attempt')
    .nth(1)
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
  const savedSource = strFromU8(archive['sources/0.js']);
  expect(savedSource).toContain('new THREE.SphereGeometry(radius, 24, 16)');
  expect(savedSource).toContain('mesh.position.x = -0.45;');
  expect(JSON.parse(strFromU8(archive['project.json'])).versions[0].repaired).toBe(true);
});
