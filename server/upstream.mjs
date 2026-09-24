export class ApiError extends Error {
  constructor(message, code = 'upstream', status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function upstreamStatusError(status) {
  const detail =
    status === 401 || status === 403
      ? '認証に失敗しました。APIキーを確認してください。'
      : status === 429
        ? '推論先が混雑しています。時間をおいて再実行してください。'
        : status === 400
          ? 'リクエストが拒否されました。モデル名・画像対応・出力上限を確認してください。'
          : `推論先が HTTP ${status} を返しました。`;
  return new ApiError(
    detail,
    status === 429 ? 'rate_limit' : status === 401 || status === 403 ? 'auth' : 'upstream',
    status,
  );
}
export async function upstream(settings, key, path, body, signal) {
  const timeout = AbortSignal.timeout(settings.timeoutSeconds * 1000);
  const started = performance.now();
  try {
    const res = await fetch(settings.baseUrl + path, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.any([timeout, signal]),
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw upstreamStatusError(res.status);
    }
    // Bound the response independently of any upstream Content-Length.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new ApiError('API応答が4MBを超えました。', 'budget');
      }
      chunks.push(value);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ApiError('API応答がJSONではありません。Base URLを確認してください。', 'protocol');
    }
    return { data, elapsedMs: Math.round(performance.now() - started) };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal.aborted) throw new ApiError('処理を停止しました。', 'cancelled', 499);
    if (timeout.aborted)
      throw new ApiError(
        'API応答がタイムアウトしました。詳細設定で待機時間を変更できます。',
        'timeout',
        504,
      );
    throw new ApiError(
      '推論先に接続できません。サーバーの起動・URL・VPN接続を確認してください。',
      'network',
    );
  }
}

export async function upstreamChatStream(settings, key, body, signal, onDelta) {
  const timeout = AbortSignal.timeout(settings.timeoutSeconds * 1000);
  const started = performance.now();
  try {
    const res = await fetch(settings.baseUrl + '/chat/completions', {
      method: 'POST',
      signal: AbortSignal.any([timeout, signal]),
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw upstreamStatusError(res.status);
    }
    if (!res.body) throw new ApiError('ストリーム応答がありません。', 'protocol');
    const decoder = new TextDecoder();
    let buffer = '';
    let size = 0;
    let content = '';
    let reasoning = '';
    let finishReason;
    let usage = null;
    let done = false;
    function event(frame) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new ApiError('ストリームのJSON形式が不正です。', 'protocol');
      }
      if (chunk.error) throw new ApiError('推論先が生成中にエラーを返しました。', 'upstream');
      const choice = chunk.choices?.[0];
      const outputDelta = choice?.delta?.content;
      const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (typeof outputDelta === 'string' && outputDelta) {
        content += outputDelta;
        onDelta('output', outputDelta);
      }
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        reasoning += reasoningDelta;
        onDelta('reasoning', reasoningDelta);
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    for await (const bytes of res.body) {
      size += bytes.length;
      if (size > 4 * 1024 * 1024) throw new ApiError('API応答が4MBを超えました。', 'budget');
      buffer += decoder.decode(bytes, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        event(frame);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    if (!done || !finishReason)
      throw new ApiError('ストリームが正常に終了しませんでした。', 'incomplete');
    return {
      data: { choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finishReason }], usage },
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal.aborted) throw new ApiError('処理を停止しました。', 'cancelled', 499);
    if (timeout.aborted)
      throw new ApiError('API応答がタイムアウトしました。詳細設定で待機時間を変更できます。', 'timeout', 504);
    throw new ApiError('推論先に接続できません。サーバーの起動・URL・VPN接続を確認してください。', 'network');
  }
}
