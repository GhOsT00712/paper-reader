export const detailLimits = { title: 300, authors: 500, tags: 240, note: 1000 };

export function readDetails(input: Record<string, unknown>, partial = false) {
  const values: Record<string, string> = {};
  for (const [key, max] of Object.entries(detailLimits)) {
    const value = input[key];
    if (value === undefined && (partial || key !== 'title')) continue;
    if (typeof value !== 'string' || value.trim().length > max || (key === 'title' && !value.trim())) return null;
    values[key] = value.trim();
  }
  return values;
}
