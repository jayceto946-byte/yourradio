import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiscoveryCache, DiscoveryCacheItem, DiscoveryCandidate } from "./types";

const CACHE_PATH = path.join(process.cwd(), "data", "discovery-cache.json");
const MAX_CACHE_ITEMS = 500;

export async function loadDiscoveryCache(): Promise<DiscoveryCache> {
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DiscoveryCache>;
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

export async function saveDiscoveryCandidates(candidates: DiscoveryCandidate[]) {
  if (candidates.length === 0) return;

  const cache = await loadDiscoveryCache();
  const byKey = new Map(cache.items.map((item) => [getCandidateKey(item), item]));
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    if (!candidate.title || !candidate.artist) continue;
    const key = getCandidateKey(candidate);
    const existing = byKey.get(key);

    if (existing) {
      byKey.set(key, {
        ...existing,
        reason: candidate.reason ?? existing.reason,
        tags: unique([...(existing.tags ?? []), ...(candidate.tags ?? [])]),
        sourcePaths: unique([...(existing.sourcePaths ?? []), ...(candidate.sourcePaths ?? [])]),
        seedWeights: [...(existing.seedWeights ?? []), ...(candidate.seedWeights ?? [])].slice(-8),
        similarityScores: [...(existing.similarityScores ?? []), ...(candidate.similarityScores ?? [])].slice(-8),
        queryVariantWeights: [...(existing.queryVariantWeights ?? []), ...(candidate.queryVariantWeights ?? [])].slice(-8),
        queryVariantTypes: unique([...(existing.queryVariantTypes ?? []), ...(candidate.queryVariantTypes ?? [])]),
        queryVariants: [...(existing.queryVariants ?? []), ...(candidate.queryVariants ?? [])].slice(-8),
        confidence: mergeConfidence(existing.confidence, candidate.confidence)
      });
      continue;
    }

    byKey.set(key, {
      ...candidate,
      createdAt: now,
      playableVerified: false,
      providerMatched: null,
      unavailableCount: 0
    });
  }

  await writeCache({ items: Array.from(byKey.values()).slice(-MAX_CACHE_ITEMS) });
}

export async function pickCachedDiscoveryCandidates(limit = 8) {
  const cache = await loadDiscoveryCache();
  const playableUnknown = cache.items
    .filter((item) => (item.unavailableCount ?? 0) < 3)
    .sort((a, b) => scoreCacheItem(b) - scoreCacheItem(a));

  return shuffle(playableUnknown).slice(0, limit);
}

export async function markDiscoveryCandidateTried(candidate: Pick<DiscoveryCandidate, "title" | "artist">, patch: Partial<Pick<DiscoveryCacheItem, "playableVerified" | "providerMatched" | "unavailableCount">>) {
  const cache = await loadDiscoveryCache();
  const key = getCandidateKey(candidate);
  const now = new Date().toISOString();
  let changed = false;

  const items = cache.items.map((item) => {
    if (getCandidateKey(item) !== key) return item;
    changed = true;
    return {
      ...item,
      ...patch,
      lastTriedAt: now,
      unavailableCount: patch.playableVerified ? item.unavailableCount ?? 0 : patch.unavailableCount ?? (item.unavailableCount ?? 0) + 1
    };
  });

  if (changed) await writeCache({ items });
}

async function writeCache(cache: DiscoveryCache) {
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function scoreCacheItem(item: DiscoveryCacheItem) {
  const confidence = item.confidence === "high" ? 3 : item.confidence === "medium" ? 2 : 1;
  return confidence - (item.unavailableCount ?? 0) * 0.7 + Math.random();
}

function getCandidateKey(candidate: Pick<DiscoveryCandidate, "title" | "artist">) {
  return `${candidate.title}::${candidate.artist}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function mergeConfidence(a: DiscoveryCacheItem["confidence"], b: DiscoveryCacheItem["confidence"]) {
  const rank = { low: 1, medium: 2, high: 3 } as const;
  return rank[b] > rank[a] ? b : a;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function shuffle<T>(items: T[]) {
  return [...items].sort(() => Math.random() - 0.5);
}
