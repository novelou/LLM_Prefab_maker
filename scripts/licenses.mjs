import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const rows = [],
  notices = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  const name = path.split('node_modules/').at(-1);
  if (!entry.license) throw new Error(`Missing license metadata: ${name}`);
  let files;
  try {
    files = await readdir(resolve(root, path));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const licenseFiles = (files || []).filter((name) =>
    /^(licen[cs]e|notice|copying|thirdpartynotice)([._-]|$)/i.test(name),
  );
  for (const file of licenseFiles) {
    const text = await readFile(resolve(root, path, file), 'utf8');
    notices.push(`## ${name} ${entry.version} — ${file}\n\n\`\`\`text\n${text.trim()}\n\`\`\`\n`);
  }
  rows.push({
    name,
    version: entry.version,
    license: entry.license,
    installed: Boolean(files),
    notices: licenseFiles.length,
    direct: Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]),
  });
}
for (const name of Object.keys(pkg.dependencies))
  if (!rows.some((r) => r.name === name && r.notices))
    throw new Error(`Runtime dependency notices missing: ${name}`);
await mkdir(resolve(root, 'docs'), { recursive: true });
const table = rows
  .map(
    (r) =>
      `| ${r.name} | ${r.version} | ${r.license} | ${r.direct ? '直接' : '間接 / platform別'} | ${r.installed ? '取得済み' : 'この環境では未導入'} |`,
  )
  .join('\n');
await writeFile(
  resolve(root, 'docs/DEPENDENCIES.md'),
  `# 依存ライブラリ\n\npackage-lock.jsonから生成。更新: npm run licenses。アプリ本体のMITと、各依存のライセンスは別です。\n\n| パッケージ | 固定版 | ライセンス識別子 | 種別 | 通知取得元 |\n|---|---|---|---|---|\n${table}\n\n[第三者通知](../THIRD_PARTY_NOTICES.md) はこの環境に導入した配布物のLICENSE / NOTICE等をそのまま収録します。platform別の未導入パッケージはlockfileのメタデータだけを記録しています。ソースZIPにはnode_modulesやブラウザ等のバイナリを含めません。別環境の依存やビルド成果物を再配布する場合は、その配布物に同梱された通知も保持してください。\n\nQwenの重み、推論サーバー、Chrome、Blenderは同梱しません。これらのライセンスを本アプリのMITへ変更するものではありません。\n`,
);
await writeFile(
  resolve(root, 'THIRD_PARTY_NOTICES.md'),
  '# Third-party notices\n\nGenerated from installed dependency distributions by `npm run licenses`. These notices retain their original terms; the project MIT license does not replace them. See [the dependency inventory](docs/DEPENDENCIES.md) for platform-specific packages not installed here.\n\n' +
    notices.join('\n'),
);
console.log(`Recorded ${rows.length} locked packages and ${notices.length} notice files.`);
