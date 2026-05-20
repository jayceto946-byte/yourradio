export function normalizeKnowledgeKey(input: string | undefined | null): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/&/g, "and")
    .replace(/[?']/g, "")
    .replace(/[?????-]/g, " ")
    .replace(/[()????[]{}]/g, " ")
    .replace(/feat.?/gi, " ")
    .replace(/ft.?/gi, " ")
    .replace(/featuring/gi, " ")
    .replace(/s+/g, " ")
    .trim();
}
