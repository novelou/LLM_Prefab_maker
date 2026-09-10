export class ApiError extends Error {
  constructor(message, code = 'upstream', status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
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
      const detail =
        res.status === 401 || res.status === 403
          ? '認証に失敗しました。APIキーを確認してください。'
          : res.status === 429
            ? '推論先が混雑しています。時間をおいて再実行してください。'
            : res.status === 400
              ? 'リクエストが拒否されました。モデル名・画像対応・出力上限を確認してください。'
              : `推論先が HTTP ${res.status} を返しました。`;
      throw new ApiError(
        detail,
        res.status === 429
          ? 'rate_limit'
          : res.status === 401 || res.status === 403
            ? 'auth'
            : 'upstream',
        res.status,
      );
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
