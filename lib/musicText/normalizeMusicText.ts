export function normalizeMusicText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[·・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeForCandidateKey(value: string) {
  return normalizeMusicText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsChinese(value: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(value);
}
