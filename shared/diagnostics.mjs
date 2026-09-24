export function textExcerpt(value) {
  if (typeof value !== 'string') return null;
  const limit = 120000;
  if (value.length <= limit) return { text: value, length: value.length, truncated: false };
  return {
    text: `${value.slice(0, 80000)}\n\n…中間を省略…\n\n${value.slice(-40000)}`,
    length: value.length,
    truncated: true,
  };
}
