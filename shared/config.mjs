export const THREE_VERSION = '0.180.0';
export const ADDONS = ['BufferGeometryUtils', 'RoundedBoxGeometry', 'ConvexGeometry'];
export const defaults = {
  baseUrl: 'http://127.0.0.1:8000/v1',
  model: '',
  maxTokens: 16384,
  timeoutSeconds: 300,
  temperature: 0.65,
  runtimeSeconds: 20,
  reasoningEffort: /** @type {const} */ ('default'),
  maxTriangles: 500000,
  maxMeshes: 2000,
  maxTextureSize: 2048,
};
export function normalizeBaseUrl(value) {
  const url = new URL(String(value).trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Base URL は認証情報・クエリを含まない HTTP(S) URL にしてください。');
  return (
    url.href
      .replace(/\/+$/, '')
      .replace(/\/(chat\/completions|models)$/, '')
      .replace(/\/+$/, '') + (url.pathname === '/' ? '/v1' : '')
  );
}
export function validateSettings(input) {
  const result = { ...defaults };
  result.baseUrl = normalizeBaseUrl(input.baseUrl ?? defaults.baseUrl);
  result.model = String(input.model ?? '')
    .trim()
    .slice(0, 300);
  result.reasoningEffort = input.reasoningEffort ?? defaults.reasoningEffort;
  if (!['default', 'none', 'low', 'medium', 'xhigh'].includes(result.reasoningEffort))
    throw new Error('Reasoning effortの設定が不正です。');
  for (const [key, min, max, integer] of [
    ['maxTokens', 256, 262144, true],
    ['timeoutSeconds', 5, 1800, true],
    ['temperature', 0, 2, false],
    ['runtimeSeconds', 2, 120, true],
    ['maxTriangles', 1000, 2000000, true],
    ['maxMeshes', 10, 10000, true],
    ['maxTextureSize', 128, 4096, true],
  ]) {
    const n = Number(input[key] ?? defaults[key]);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
      throw new Error(`${key}: ${min}〜${max} の${integer ? '整数' : '数値'}を指定してください。`);
    result[key] = n;
  }
  return result;
}
