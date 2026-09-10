import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { defaults } from '../shared/config.mjs';
import { systemPrompt } from '../server/prompt.mjs';
import { createHash } from 'node:crypto';
const cases = [
  [
    'chair',
    '木製の椅子。4本の脚、四角い座面、背もたれに3本の縦桟。座面の高さ0.45m。自然な茶色。',
    ['4本脚', '四角い座面', '縦桟3本の背もたれ', '茶色の木部'],
  ],
  [
    'table',
    '木製の机。幅1.2m、奥行き0.6m、高さ0.75m。長方形の天板、4本脚、前面右側に引き出しと取っ手。',
    ['長方形の天板', '4本脚', '前面右の引き出しと取っ手', '木製の色'],
  ],
  [
    'house',
    'ローポリの家。白い壁、赤い切妻屋根、前面の茶色いドアと青い窓2つ、煙突。幅4m、奥行き3m。',
    ['白い壁', '赤い切妻屋根', '前面ドアと青い窓2つ', '煙突'],
  ],
  [
    'tower',
    '石造りの円形の見張り塔。高さ5m、直径2m。灰色の円筒形本体、頂上の胸壁、縦長の窓3つ、地上のアーチ型入口。',
    ['灰色の円筒形塔', '頂上の胸壁', '縦長の窓', '地上入口'],
  ],
  [
    'robot',
    'かわいいローポリのロボット小物。高さ0.5m。青い箱型の胴、頭に黄色い目2つ、左右の腕、2本脚、頭上にアンテナ。',
    ['青い箱型胴', '黄色い目2つ', '左右の腕と2本脚', 'アンテナ'],
  ],
  [
    'car',
    'ローポリの赤い小型自動車。全長3m。4輪、青いフロントガラス、白いヘッドライト2つ、後部に赤いテールライト。',
    ['赤い車体', '4輪', '青いフロントガラス', '前後のライト'],
  ],
  [
    'lamp',
    '卓上ランプ。全高0.5m。真鍮色の丸いベースと細い支柱、緑のドーム型シェード、その内側の暖色電球。',
    ['真鍮色の丸いベース', '細い支柱', '緑のドーム型シェード', '内側の暖色電球'],
  ],
  [
    'vase',
    '陶器の花瓶。高さ0.3m。クリーム色、丸く膨らんだ胴、細い首、上部に開いた口と縁、内側の空洞。回転体で滑らかに。',
    ['クリーム色', '膨らんだ胴と細い首', '開口部と縁', '空洞'],
  ],
  [
    'tree',
    'ローポリの広葉樹。高さ3m。茶色の幹と枝、濃淡の緑の葉のかたまり5つ以上。根元が少し広がる。',
    ['茶色の幹と枝', '濃淡の緑', '5つ以上の樹冠のかたまり', '広がる根元'],
  ],
  [
    'container',
    'SF貨物コンテナ。幅2m、奥行き1m、高さ1m。グレーの箱、オレンジの補強フレーム、黒いパネルの継ぎ目、前面の青いロック。',
    ['グレーの箱', 'オレンジの補強', '黒い継ぎ目', '青いロック'],
  ],
];
const runName = process.env.EVAL_RUN || 'evaluation';
if (!/^[a-zA-Z0-9-]+$/.test(runName)) throw new Error('EVAL_RUN must be a simple directory name.');
const out = `.local/${runName}`;
const repeats = Math.min(3, Math.max(1, Number(process.env.EVAL_REPEATS || 3)));
const selected = process.env.EVAL_CASES?.split(',');
await mkdir(out, { recursive: true });
let results = [];
try {
  results = JSON.parse(await readFile(out + '/results.json', 'utf8'));
} catch {}
const base = 'http://127.0.0.1:4173';
const session = await (await fetch(base + '/api/session')).json();
const benchmarkSettings = {
  ...defaults,
  baseUrl: session.settings.baseUrl,
  model: session.settings.model,
  reasoningEffort: session.settings.reasoningEffort,
};
if (!benchmarkSettings.model) throw new Error('Configure the model in the app before evaluating.');
const promptHash = createHash('sha256').update(systemPrompt).digest('hex');
const runtimeHash = createHash('sha256')
  .update(await readFile('dist/runtime-worker.js'))
  .digest('hex');
if (session.promptHash !== promptHash)
  throw new Error(
    'The running server has a different prompt. Restart npm start before benchmarking.',
  );
let previousManifest;
if (results.length) {
  previousManifest = JSON.parse(await readFile(out + '/manifest.json', 'utf8'));
  if (
    previousManifest.systemPromptSha256 !== promptHash ||
    previousManifest.runtimeSha256 !== runtimeHash ||
    JSON.stringify(previousManifest.settings) !== JSON.stringify(benchmarkSettings)
  )
    throw new Error(
      'This result directory belongs to different prompt/runtime/settings. Choose a new EVAL_RUN; existing evidence was not modified.',
    );
}
const configured = await fetch(base + '/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token },
  body: JSON.stringify(benchmarkSettings),
});
if (!configured.ok) throw new Error(await configured.text());
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const limit = Number(process.env.EVAL_LIMIT || 30);
await writeFile(out + '/system-prompt.txt', systemPrompt);
await writeFile(
  out + '/manifest.json',
  JSON.stringify(
    {
      stage: runName,
      date: new Date().toISOString(),
      settings: benchmarkSettings,
      repeats,
      selected,
      systemPromptSha256: promptHash,
      runtimeSha256: runtimeHash,
      batches: [
        ...(previousManifest?.batches ||
          (previousManifest
            ? [
                {
                  date: previousManifest.date,
                  repeats: previousManifest.repeats,
                  selected: previousManifest.selected,
                },
              ]
            : [])),
        { date: new Date().toISOString(), repeats, selected },
      ],
    },
    null,
    2,
  ),
);
let attempted = 0;
try {
  for (const [name, prompt, criteria] of cases)
    for (let repeat = 0; repeat < repeats; repeat++) {
      if (selected && !selected.includes(name)) continue;
      const key = `${name}-${repeat + 1}`;
      if (results.some((r) => r.key === key)) continue;
      if (attempted++ >= limit) break;
      await page.goto(base);
      await page.getByRole('button', { name: '接続テスト', exact: true }).waitFor();
      await page.getByLabel('モデルの説明・追加指示').fill(prompt);
      await page.getByText('詳細設定', { exact: false }).first().click();
      await page.getByLabel('生成seed', { exact: true }).fill(String(42 + repeat));
      const outputs = [];
      const requests = [];
      const onResponse = async (response) => {
        if (response.url().endsWith('/api/generate'))
          try {
            outputs.push(await response.json());
          } catch {}
      };
      const onRequest = (request) => {
        if (request.url().endsWith('/api/generate')) requests.push(request.postDataJSON());
      };
      page.on('response', onResponse);
      page.on('request', onRequest);
      const started = Date.now();
      console.log(`START ${key}`);
      await page.getByRole('button', { name: 'モデルを生成', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.job-status.working'), null, {
        timeout: 650000,
      });
      const error = await page.locator('.message.error').allTextContents();
      let success = await page.getByRole('button', { name: 'GLBを保存', exact: true }).isEnabled();
      const stats = await page.locator('.model-info').innerText();
      if (success) {
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'GLBを保存', exact: true }).click();
        await (await downloadPromise).saveAs(`${out}/${key}.glb`);
        for (const [view, label] of [
          ['iso', '全体'],
          ['front', '正面'],
          ['side', '側面'],
          ['top', '上面'],
        ]) {
          await page.getByRole('button', { name: label, exact: true }).click();
          await page.waitForTimeout(120);
          await page.locator('.viewport-area').screenshot({ path: `${out}/${key}-${view}.png` });
        }
        const downloadProject = page.waitForEvent('download');
        await page.getByRole('button', { name: 'プロジェクト保存', exact: true }).click();
        await (await downloadProject).saveAs(`${out}/${key}.qmodel`);
      }
      const final = outputs.filter((x) => x.source).at(-1);
      if (final) await writeFile(`${out}/${key}.js`, final.source);
      for (let i = 0; i < outputs.length; i++)
        if (outputs[i].source)
          await writeFile(`${out}/${key}-attempt${i + 1}.js`, outputs[i].source);
      const row = {
        key,
        name,
        repeat: repeat + 1,
        prompt,
        criteria,
        seed: 42 + repeat,
        success,
        firstValid: success && outputs.length === 1,
        attempts: outputs.length,
        elapsedMs: Date.now() - started,
        apiMs: outputs.reduce((s, r) => s + (r.elapsedMs || r.details?.elapsedMs || 0), 0),
        usage: outputs.reduce(
          (s, r) => s + (r.usage?.total_tokens || r.details?.usage?.total_tokens || 0),
          0,
        ),
        error,
        repairs: requests.filter((x) => x.error).map((x) => x.error),
        stats,
        shapeReview: 'pending',
      };
      results.push(row);
      await writeFile(out + '/results.json', JSON.stringify(results, null, 2));
      console.log(
        `DONE ${key}: ${success ? 'PASS' : 'FAIL'} attempts=${outputs.length} seconds=${Math.round(row.elapsedMs / 1000)}`,
      );
      page.off('response', onResponse);
      page.off('request', onRequest);
    }
} finally {
  await browser.close();
}
console.log(
  `RESULT ${results.filter((r) => r.success).length}/${results.length}; first pass ${results.filter((r) => r.firstValid).length}/${results.length}`,
);
