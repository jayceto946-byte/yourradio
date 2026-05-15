import { normalizeForCandidateKey } from "../musicText/normalizeMusicText";
import type { DiscoveryCandidate } from "../discovery/types";

export function mergeExpandedCandidates(candidates: DiscoveryCandidate[]) {
  const byKey = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...candidate });
      continue;
    }
    byKey.set(key, {
      ...existing,
      sourcePaths: unique([...(existing.sourcePaths ?? []), ...(candidate.sourcePaths ?? [])]),
      seedWeights: [...(existing.seedWeights ?? []), ...(candidate.seedWeights ?? [])],
      similarityScores: [...(existing.similarityScores ?? []), ...(candidate.similarityScores ?? [])],
      queryVariantWeights: [...(existing.queryVariantWeights ?? []), ...(candidate.queryVariantWeights ?? [])],
      queryVariantTypes: unique([...(existing.queryVariantTypes ?? []), ...(candidate.queryVariantTypes ?? [])]),
      queryVariants: [...(existing.queryVariants ?? []), ...(candidate.queryVariants ?? [])],
      tags: unique([...(existing.tags ?? []), ...(candidate.tags ?? [])]),
      confidence: existing.confidence === "high" || candidate.confidence === "high" ? "high" : "medium"
    });
  }
  return [...byKey.values()].sort((a, b) => effectiveSimilarity(b) - effectiveSimilarity(a));
}

export function effectiveSimilarity(candidate: DiscoveryCandidate) {
  const weights = candidate.queryVariantWeights ?? [];
  return Math.max(...(candidate.similarityScores ?? [0]).map((score, index) => score * (weights[index] ?? 1)), 0);
}

function candidateKey(candidate: DiscoveryCandidate) {
  return `${normalizeForCandidateKey(candidate.title)}::${normalizeForCandidateKey(candidate.artist)}`;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
