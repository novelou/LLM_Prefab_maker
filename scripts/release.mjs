import { readFile, writeFile, readdir, mkdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const top = [
  'LICENSE',
  'README.md',
  'PLAN.md',
  'POC_REPORT.md',
  'PROMPT_TUNING_REPORT.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'playwright.config.ts',
  'index.html',
  'start.cmd',
  'start.ps1',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
  '.prettierignore',
];
const directories = ['src', 'server', 'shared', 'runtime', 'scripts', 'tests', 'docs'];
const files = [...top];
async function walk(path) {
  for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
    const next = `${path}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed in release: ${next}`);
    if (entry.isDirectory()) await walk(next);
    else if (entry.isFile()) files.push(next);
  }
}
for (const directory of directories) await walk(directory);
const buffers = new Map(),
  problems = [];
for (const path of files.sort()) {
  if ((await lstat(resolve(root, path))).isSymbolicLink()) throw new Error(`Symlink: ${path}`);
  if (
    /(^|\/)(\.local|node_modules|dist|release|test-results)(\/|$)|(^|\/)\.env($|\.)|\.(pem|key|qmodel|glb|zip|log)$/i.test(
      path,
    )
  )
    problems.push(`Excluded artifact: ${path}`);
  const bytes = await readFile(resolve(root, path));
  buffers.set(path, bytes);
  if (/\.(png|jpg|jpeg|webp)$/i.test(path)) continue;
  const text = bytes.toString('utf8');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bsk-[A-Za-z0-9_-]{24,}\b/.test(text)
  )
    problems.push(`Possible credential: ${path}`);
  if (/\b[A-Za-z]:[\\/]Users[\\/][^\s]+/.test(text))
    problems.push(`Personal filesystem path: ${path}`);
  for (const match of text.matchAll(/https?:\/\/(\d+\.\d+\.\d+\.\d+)(?=[:/\s'"`]|$)/g))
    if (!['127.0.0.1', '0.0.0.0'].includes(match[1]))
      problems.push(`Non-loopback literal endpoint: ${path}`);
  if (path.endsWith('.md')) {
    const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
    for (const [, raw] of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = raw.trim().replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      const full = resolve(root, dirname(path), decodeURIComponent(target));
      const local = relative(root, full).split(sep).join('/');
      if (
        local.startsWith('../') ||
        (!files.includes(local) && !files.some((f) => f.startsWith(local + '/')))
      )
        problems.push(`Broken or unpublished link: ${path} → ${target}`);
    }
  }
}
const pkg = JSON.parse(buffers.get('package.json'));
const lock = JSON.parse(buffers.get('package-lock.json'));
for (const key of ['name', 'version', 'license', 'engines', 'dependencies', 'devDependencies']) {
  if (JSON.stringify(pkg[key]) !== JSON.stringify(lock.packages[''][key]))
    problems.push(`Package / lockfile mismatch: ${key}`);
}
if (pkg.license !== 'MIT' || lock.packages[''].license !== 'MIT' || pkg.version !== lock.version)
  problems.push('Package / lockfile release metadata mismatch');
if (!buffers.get('LICENSE').toString().includes('MIT License'))
  problems.push('MIT license missing');
if (problems.length) throw new Error(problems.join('\n'));
console.log(
  `Release checks passed: ${files.length} files; local Markdown links and source patterns checked.`,
);
if (!process.argv.includes('--check')) {
  const prefix = `${pkg.name}-${pkg.version}`;
  const archive = zipSync(
    Object.fromEntries([...buffers].map(([path, bytes]) => [`${prefix}/${path}`, bytes])),
    { level: 9 },
  );
  const name = `${prefix}-source.zip`;
  await mkdir(resolve(root, 'release'), { recursive: true });
  await writeFile(resolve(root, 'release', name), archive);
  await writeFile(
    resolve(root, 'release', name + '.sha256'),
    createHash('sha256').update(archive).digest('hex') + '  ' + name + '\n',
  );
  await writeFile(
    resolve(root, 'release', 'manifest.json'),
    JSON.stringify(
      {
        name,
        version: pkg.version,
        license: pkg.license,
        files: files.map((path) => ({
          path,
          sha256: createHash('sha256').update(buffers.get(path)).digest('hex'),
        })),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Created release/${name} (${archive.length} bytes).`);
}
