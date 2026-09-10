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
export function executableSource(source) {
  return source
    .replace(/\bexport\s+default\s+(?=(?:async\s+)?function\s+createModel)/g, '')
    .replace(
      /\bexport\s+(?=(?:async\s+)?function\s+createModel|(?:const|let|var)\s+createModel)/g,
      '',
    );
}
