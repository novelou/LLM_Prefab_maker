import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = `.local/${process.env.EVAL_RUN || 'evaluation'}`;
const rows = JSON.parse(await readFile(root + '/results.json', 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1500, height: 1000 },
  deviceScaleFactor: 1,
});
await mkdir(root + '/review', { recursive: true });
try {
  for (const category of [...new Set(rows.map((x) => x.name))]) {
    let html =
      '<html><meta charset="utf-8"><style>body{background:#11161c;color:#ccd6df;font:16px sans-serif;margin:12px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}h1{font-size:22px;margin:10px 0}h2{font-size:14px;margin:4px 0}img{width:100%;display:block}article{background:#202630;padding:5px}</style><h1>' +
      category +
      ' · iso / front</h1><div class="grid">';
    for (const view of ['iso', 'front'])
      for (const row of rows.filter((x) => x.name === category)) {
        if (!row.success) continue;
        const png = await readFile(`${root}/${row.key}-${view}.png`);
        html += `<article><h2>${row.key} / ${view}</h2><img src="data:image/png;base64,${png.toString('base64')}"></article>`;
      }
    html += '</div></html>';
    await page.setContent(html);
    await page.screenshot({ path: `${root}/review/${category}.png`, fullPage: true });
    await writeFile(`${root}/review/${category}.html`, html);
  }
} finally {
  await browser.close();
}
console.log('Review galleries updated.');
