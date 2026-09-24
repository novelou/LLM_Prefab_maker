import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { Color } from 'three';
import { calibrationSource } from '../fixtures/calibration.js';
const cube = `function createModel({THREE}) {const modelRoot=new THREE.Group();modelRoot.name='one metre';const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:0xff4444}));mesh.position.y=.5;modelRoot.add(mesh);return {modelRoot};}`;
async function ready(page: any) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '接続テスト', exact: true })).toBeEnabled();
}
async function mockSource(page: any, source: string) {
  await page.route('**/api/generate', (route: any) =>
    route.fulfill({
      json: { source, elapsedMs: 123, usage: { total_tokens: 123 }, model: 'fixture' },
    }),
  );
}
test('calibration exports embedded textures, preserves dimensions, hierarchy, negative scale; project restores', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ready(page);
  await page.screenshot({ path: '.local/poc/studio-empty.png', fullPage: true });
  await page.getByRole('button', { name: '校正モデルを試す' }).click();
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await expect(page.locator('.message.error')).toHaveCount(0);
  await page.screenshot({ path: '.local/poc/studio-calibration.png', fullPage: true });
  for (const name of ['正面', '側面', '上面', '全体'])
    await page.getByRole('button', { name, exact: true }).click();
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'GLBを保存', exact: true }).click(),
  ]);
  await dl.saveAs('.local/poc/calibration.glb');
  const bytes = await readFile(await dl.path());
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  expect(json.cameras).toBeUndefined();
  expect(json.extensions?.KHR_lights_punctual).toBeUndefined();
  expect(json.images.length).toBe(1);
  expect(json.images[0].bufferView).toBeGreaterThanOrEqual(0);
  expect(json.images[0].uri).toBeUndefined();
  expect(json.nodes.find((n: any) => n.name === 'Right assembly').children.length).toBe(2);
  const unit = json.nodes.find(
    (n: any) => n.name === '1m_calibration_cube' || n.name === '1m calibration cube',
  );
  const accessor = json.accessors[json.meshes[unit.mesh].primitives[0].attributes.POSITION];
  const baseColor =
    json.materials[json.meshes[unit.mesh].primitives[0].material].pbrMetallicRoughness
      .baseColorFactor;
  new Color('#4b86d2').toArray().forEach((value, i) => expect(baseColor[i]).toBeCloseTo(value, 6));
  expect(accessor.max.map((x: number, i: number) => x - accessor.min[i])).toEqual([1, 1, 1]);
  const negative = json.nodes.find(
    (n: any) => n.name === 'Negative scale marker' || n.name === 'Negative_scale_marker',
  );
  expect(negative.matrix[0]).toBeLessThan(0);
  const [project] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'プロジェクト保存', exact: true }).click(),
  ]);
  await project.saveAs('.local/poc/calibration.qmodel');
  const archive = unzipSync(new Uint8Array(await readFile(await project.path())));
  const meta = strFromU8(archive['project.json']);
  expect(meta).not.toContain('apiKey');
  expect(meta).not.toContain('baseUrl');
  await page.reload();
  await page.locator('input[type=file]').first().setInputFiles('.local/poc/calibration.qmodel');
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  expect(errors).toEqual([]);
});
test('generation, revision, undo and one repair retain the last successful version', async ({
  page,
}) => {
  await ready(page);
  await mockSource(page, cube);
  await page.getByLabel('モデルの説明・追加指示').fill('赤い立方体');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  await page.unroute('**/api/generate');
  let calls = 0;
  await page.route('**/api/generate', async (route) => {
    calls++;
    await route.fulfill({
      json: {
        source:
          calls === 1
            ? 'function createModel(){throw new Error("repair me");}'
            : cube.replace('0xff4444', '0x4444ff'),
        elapsedMs: 100,
        model: 'fixture',
      },
    });
  });
  await page.getByLabel('モデルの説明・追加指示').fill('青くしてください');
  await page.getByRole('button', { name: '追加指示で修正', exact: true }).click();
  await expect(page.locator('.history-list>button')).toHaveCount(2);
  expect(calls).toBe(2);
  await expect(page.locator('.message.success')).toContainText('自動修復');
  await page.getByRole('button', { name: 'ひとつ戻す' }).click();
  await expect(page.locator('.history-list>.selected')).toContainText('v01');
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  await page.unroute('**/api/generate');
  await mockSource(page, 'function createModel(){throw new Error("broken");}');
  await page.getByRole('button', { name: '追加指示で修正', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('broken');
  const generationDetails = page.locator('.generation-trace');
  await generationDetails.locator('summary').click();
  await expect(generationDetails).toContainText('モデル構築・GLB検証');
  await expect(generationDetails.locator('pre').last()).toContainText('throw new Error("broken")');
  await expect(page.locator('.history-list>.selected')).toContainText('v01');
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
});
test('opaque worker blocks network and storage, can time out and cancel infinite loops', async ({
  page,
}) => {
  await ready(page);
  await mockSource(page, cube);
  await page.getByLabel('モデルの説明・追加指示').fill('cube');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  await page.getByText('詳細設定', { exact: false }).first().click();
  await page.getByLabel('実行時間（秒）').fill('2');
  await page.getByLabel('実行エラーを1回まで自動修復').uncheck();
  await page.unroute('**/api/generate');
  await mockSource(page, 'function createModel(){while(true){}}');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('実行時間の上限');
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  await page.getByLabel('実行時間（秒）').fill('20');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.locator('.job-status')).toContainText('形状とGLB');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('button', { name: 'モデルを生成', exact: true })).toBeEnabled();
  let apiRequests = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/session')) apiRequests++;
  });
  const probe = cube.replace(
    'function createModel({THREE}) {',
    `async function createModel({THREE}) { let network=false,storage=false;try{await fetch('http://127.0.0.1:4173/api/session');network=true;}catch{}try{indexedDB.open('forbidden');storage=true;}catch{}if(network||storage)throw new Error('isolation failure');`,
  );
  await page.unroute('**/api/generate');
  await mockSource(page, probe);
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.locator('.history-list>button')).toHaveCount(2);
  expect(apiRequests).toBe(0);
});
test('shader preview remains available but unsupported export is explicit', async ({ page }) => {
  await ready(page);
  await mockSource(
    page,
    cube.replace(
      'new THREE.MeshStandardMaterial({color:0xff4444})',
      `new THREE.ShaderMaterial({vertexShader:'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'void main(){gl_FragColor=vec4(1.,0.,0.,1.);}'})`,
    ),
  );
  await page.getByLabel('モデルの説明・追加指示').fill('shader');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.locator('.export-warnings')).toContainText('ShaderMaterial');
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'プロジェクト保存', exact: true })).toBeEnabled();
});
test('a complete response missing the entry point gets exactly one repair', async ({ page }) => {
  await ready(page);
  let calls = 0;
  await page.route('**/api/generate', async (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 400, json: { error: 'createModel 関数が含まれていません。', code: 'contract', details: { rejectedSource: 'const root = 1;', elapsedMs: 10, usage: { total_tokens: 20 } } } });
    expect(route.request().postDataJSON().source).toBe('const root = 1;');
    await route.fulfill({ json: { source: cube, model: 'fixture', elapsedMs: 10, usage: { total_tokens: 30 } } });
  });
  await page.getByLabel('モデルの説明・追加指示').fill('cube');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  expect(calls).toBe(2);
  await expect(page.locator('.message.success')).toContainText('自動修復');
  await expect(page.locator('.model-info')).toContainText('50');
});

test('incomplete streamed output stays available in collapsed generation details', async ({ page }) => {
  await ready(page);
  await page.getByLabel('実行エラーを1回まで自動修復').uncheck();
  await page.route('**/api/generate', (route) =>
    route.fulfill({
      contentType: 'application/x-ndjson',
      body: [
        { type: 'start' },
        { type: 'delta', channel: 'reasoning', text: '途中までの推論' },
        { type: 'delta', channel: 'output', text: 'function createModel() {' },
        {
          type: 'error',
          error: '応答が正常終了していません (length)。',
          code: 'incomplete',
          status: 400,
          details: { finishReason: 'length', usage: { total_tokens: 256 } },
        },
      ]
        .map((event) => JSON.stringify(event) + '\n')
        .join(''),
    }),
  );
  await page.getByLabel('モデルの説明・追加指示').fill('立方体');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('length');
  const details = page.locator('.generation-trace');
  await expect(details).toBeVisible();
  await expect(details.locator('pre').first()).toBeHidden();
  await details.locator('summary').click();
  await expect(details).toContainText('終了理由: length');
  await expect(details).toContainText('トークン: 256');
  await expect(details.locator('pre').first()).toContainText('function createModel() {');
  await expect(details.locator('pre').last()).toContainText('途中までの推論');
});

test('resource budgets and invalid coordinates fail without replacing the model', async ({
  page,
}) => {
  await ready(page);
  await mockSource(page, cube);
  await page.getByLabel('モデルの説明・追加指示').fill('cube');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
  await page.getByLabel('実行エラーを1回まで自動修復').uncheck();
  await page.getByText('詳細設定', { exact: false }).first().click();
  await page.getByLabel('三角形数の上限').fill('1000');
  await page.unroute('**/api/generate');
  await mockSource(
    page,
    cube.replace('new THREE.BoxGeometry(1,1,1)', 'new THREE.IcosahedronGeometry(1,10)'),
  );
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('生成規模');
  await expect(page.locator('.history-list>button')).toHaveCount(1);
  await page.unroute('**/api/generate');
  await mockSource(
    page,
    cube.replace('mesh.position.y=.5;', 'mesh.geometry.attributes.position.setX(0,NaN);'),
  );
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('NaN/Infinity');
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeEnabled();
});

test('vertex displacement warns instead of silently losing geometry in GLB', async ({ page }) => {
  await ready(page);
  await mockSource(
    page,
    cube.replace(
      'new THREE.MeshStandardMaterial({color:0xff4444})',
      'new THREE.MeshStandardMaterial({displacementMap:new THREE.CanvasTexture(new OffscreenCanvas(8,8)),displacementScale:.1})',
    ),
  );
  await page.getByLabel('モデルの説明・追加指示').fill('displacement');
  await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
  await expect(page.locator('.export-warnings')).toContainText('displacementMap');
  await expect(page.getByRole('button', { name: 'GLBを保存', exact: true })).toBeDisabled();
});

test('small-screen layout remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page.getByRole('button', { name: 'モデルを生成', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '.local/poc/studio-mobile.png', fullPage: true });
});
