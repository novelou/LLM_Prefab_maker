export function extractSource(content, finishReason) {
  if (finishReason !== 'stop')
    throw Object.assign(
      new Error(
        `コードを実行しません。応答が正常終了していません (${finishReason ?? '終了理由なし'})。出力トークン上限を増やしてください。`,
      ),
      { code: 'incomplete' },
    );
  if (typeof content !== 'string' || !content.trim())
    throw Object.assign(new Error('モデルからコードが返りませんでした。'), { code: 'empty' });
  let source = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = [...source.matchAll(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/g)];
  if (fenced.length === 1) source = fenced[0][1].trim();
  if (!/\b(?:function\s+createModel\s*\(|(?:const|let|var)\s+createModel\s*=)/.test(source))
    throw Object.assign(new Error('createModel 関数が含まれていません。'), { code: 'contract' });
  if (source.length > 500000)
    throw Object.assign(new Error('コードが500KBの上限を超えました。'), { code: 'budget' });
  return source;
}
export function numberedSource(source) {
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => `${index + 1}|${line}`)
    .join('\n');
}

function patchError(message) {
  return Object.assign(new Error(message), { code: 'patch' });
}

function checkedEditedSource(source, finishReason) {
  try {
    return extractSource(source, finishReason);
  } catch (error) {
    if (error.code === 'contract') error.rejectedSource = source;
    throw error;
  }
}

export function extractEditedSource(content, finishReason, original) {
  if (finishReason !== 'stop') return extractSource(content, finishReason);
  if (typeof content !== 'string' || !content.trim()) throw patchError('部分編集の応答が空です。');
  const response = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)```$/.exec(response);
  const body = (fenced ? fenced[1] : response).trim();
  if (!body) throw patchError('部分編集の応答が空です。');
  // Full source is the default for revisions and a fallback for error repair.
  if (!body.startsWith('{') && !body.startsWith('[')) {
    try {
      return extractSource(content, finishReason);
    } catch (error) {
      if (error.code === 'contract' || error.code === 'empty')
        throw patchError('部分編集も完全なソースも返されませんでした。');
      throw error;
    }
  }
  let patch;
  try {
    patch = JSON.parse(body);
  } catch {
    throw patchError('部分編集のJSON形式が不正です。');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw patchError('部分編集の形式が不正です。');
  if (patch.mode === 'source') {
    if (typeof patch.source !== 'string' || !patch.source.trim())
      throw patchError('ソース全文が指定されていません。');
    return checkedEditedSource(patch.source, finishReason);
  }
  if (
    patch.mode !== 'edits' ||
    !Array.isArray(patch.edits) ||
    !patch.edits.length ||
    patch.edits.length > 32
  )
    throw patchError('部分編集は1～32件のeditsを指定してください。');

  const lines = original.replace(/\r\n?/g, '\n').split('\n');
  const edits = patch.edits.map((edit) => {
    if (
      !edit ||
      !Number.isSafeInteger(edit.startLine) ||
      edit.startLine < 1 ||
      typeof edit.old !== 'string' ||
      !edit.old ||
      typeof edit.new !== 'string' ||
      /\r/.test(edit.old + edit.new) ||
      edit.old.endsWith('\n')
    )
      throw patchError('部分編集の行番号またはold/newが不正です。');
    const start = edit.startLine - 1;
    const oldLines = edit.old.split('\n');
    const end = start + oldLines.length;
    if (end > lines.length || lines.slice(start, end).join('\n') !== edit.old)
      throw patchError(`部分編集の${edit.startLine}行目が元コードと一致しません。`);
    return { start, end, replacement: edit.new === '' ? [] : edit.new.split('\n') };
  });
  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++)
    if (edits[i].start < edits[i - 1].end) throw patchError('部分編集の行範囲が重複しています。');
  for (const edit of edits.reverse())
    lines.splice(edit.start, edit.end - edit.start, ...edit.replacement);
  return checkedEditedSource(lines.join('\n'), finishReason);
}
export const extractRepairSource = extractEditedSource;
export function executableSource(source) {
  return source
    .replace(/\bexport\s+default\s+(?=(?:async\s+)?function\s+createModel)/g, '')
    .replace(
      /\bexport\s+(?=(?:async\s+)?function\s+createModel|(?:const|let|var)\s+createModel)/g,
      '',
    );
}
