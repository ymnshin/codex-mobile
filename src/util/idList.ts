export function normalizeIdList(values: Iterable<string>): string[] {
  return [...new Set(Array.from(values, (value) => value.trim()).filter(Boolean))];
}

export function parseCsvIdList(raw: string): string[] {
  return normalizeIdList(raw.split(","));
}
