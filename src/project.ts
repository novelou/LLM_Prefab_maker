import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { THREE_VERSION, ADDONS } from '../shared/config.mjs';
import type { Version } from './types';
export function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
export function saveProject(versions: Version[], index: number) {
  const assets: Record<string, Uint8Array> = {};
  const saved = versions.map((v, i) => {
    const sourceFile = `sources/${i}.js`;
    assets[sourceFile] = strToU8(v.source);
    const images = (v.images ?? []).map((data, j) => {
      const path = `references/${i}-${j}.txt`;
      assets[path] = strToU8(data);
      return path;
    });
    return {
      id: v.id,
      sourceFile,
      prompt: v.prompt,
      seed: v.seed,
      createdAt: v.createdAt,
      model: v.model,
      elapsedMs: v.elapsedMs,
      usage: v.usage,
      repaired: v.repaired,
      images,
    };
  });
  assets['project.json'] = strToU8(
    JSON.stringify(
      {
        format: 'qwen-model-studio',
        version: 1,
        dependencies: { three: THREE_VERSION, addons: ADDONS },
        index,
        versions: saved,
      },
      null,
      2,
    ),
  );
  download(
    zipSync(assets, { level: 6 }) as Uint8Array<ArrayBuffer>,
    'model-project.qmodel',
    'application/zip',
  );
}
export async function readProject(
  file: File,
): Promise<{ versions: Omit<Version, 'stats'>[]; index: number }> {
  if (file.size > 32 * 1024 * 1024) throw new Error('プロジェクトは32MB以下にしてください。');
  let total = 0,
    count = 0;
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter(entry) {
      total += entry.originalSize;
      count++;
      if (
        total > 64 * 1024 * 1024 ||
        count > 120 ||
        entry.name.includes('..') ||
        entry.name.startsWith('/')
      )
        throw new Error('アーカイブがサイズ上限を超えたか、ファイル名が不正です。');
      return true;
    },
  });
  if (!files['project.json'] || files['project.json'].byteLength > 1024 * 1024)
    throw new Error('プロジェクト情報がありません。');
  const p = JSON.parse(strFromU8(files['project.json']));
  if (
    p.format !== 'qwen-model-studio' ||
    p.version !== 1 ||
    p.dependencies?.three !== THREE_VERSION ||
    JSON.stringify(p.dependencies?.addons) !== JSON.stringify(ADDONS)
  )
    throw new Error(
      `プロジェクト形式または依存バージョンが一致しません。three.js ${THREE_VERSION} 用のプロジェクトが必要です。`,
    );
  if (
    !Array.isArray(p.versions) ||
    !p.versions.length ||
    p.versions.length > 20 ||
    !Number.isInteger(p.index) ||
    p.index < 0 ||
    p.index >= p.versions.length
  )
    throw new Error('履歴の形式が不正です。');
  const versions = p.versions.map((v: any) => {
    if (
      typeof v.sourceFile !== 'string' ||
      !files[v.sourceFile] ||
      files[v.sourceFile].length > 500000 ||
      typeof v.prompt !== 'string' ||
      v.prompt.length > 16000 ||
      typeof v.model !== 'string' ||
      v.model.length > 300 ||
      !Number.isInteger(v.seed) ||
      v.seed < 0 ||
      v.seed > 2147483647
    )
      throw new Error('履歴データが不正です。');
    const source = strFromU8(files[v.sourceFile]);
    if (!source.includes('createModel')) throw new Error('生成コードがありません。');
    if (!Array.isArray(v.images) || v.images.length > 4)
      throw new Error('参照画像の形式が不正です。');
    const images = v.images.map((path: unknown) => {
      if (typeof path !== 'string' || !files[path] || files[path].length > 2800000)
        throw new Error('参照画像が不正です。');
      const image = strFromU8(files[path]);
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image))
        throw new Error('参照画像の形式が不正です。');
      return image;
    });
    return {
      id: crypto.randomUUID(),
      source,
      prompt: v.prompt,
      seed: v.seed,
      model: v.model,
      createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
      images,
      repaired: v.repaired === true,
    };
  });
  return { versions, index: p.index };
}
