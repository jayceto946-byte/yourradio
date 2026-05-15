import { generateLastFmDiscoveryPlan } from "./lastfmProvider";
import { pickCachedDiscoveryCandidates, saveDiscoveryCandidates } from "./localDiscoveryCache";
import type { DiscoveryCandidate, DiscoveryPlan, GenerateDiscoveryPlanInput } from "./types";

export async function generateDiscoveryPlan(input: GenerateDiscoveryPlanInput): Promise<DiscoveryPlan> {
  const lastFmPlan = await generateLastFmDiscoveryPlan(input).catch(() => null);
  const seed = input.sourceSeed ?? input.seedTrack;

  if (!lastFmPlan) {
    return {
      seed: { title: seed?.title ?? "", artist: seed?.artist ?? "", album: seed?.album ?? "" },
      searchIntent: "lastfm_entity_based_expansion_failed",
      similarSongQueries: [],
      similarArtistQueries: [],
      candidateSongs: [],
      avoidKeywords: input.tasteProfile.avoidKeywords,
      reason: "Last.fm returned no entity-based candidates. LLM/free-text keyword fallback is disabled.",
      source: "lastfm",
      error: "LASTFM_NO_RESULTS"
    };
  }

  await saveDiscoveryCandidates(lastFmPlan.candidateSongs).catch(() => undefined);
  return lastFmPlan;
}

export async function getDiscoveryCandidatePool(plan: DiscoveryPlan, limit = 12): Promise<DiscoveryCandidate[]> {
  const cached = await pickCachedDiscoveryCandidates(Math.max(2, Math.floor(limit / 4))).catch(() => []);
  const cacheCandidates = cached
    .filter((item) => item.source === "lastfm")
    .map((item) => ({ ...item, source: "cache" as const }));
  return mergeCandidates([...plan.candidateSongs, ...cacheCandidates]).slice(0, limit);
}

function mergeCandidates(candidates: DiscoveryCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.title || !candidate.artist) return false;
    const key = `${candidate.title}::${candidate.artist}`.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export * from "./types";

