export function normalizeKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}
