import type { RankedCandidate } from "./rankCandidates";

export type LlmRankedCandidateView = {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  totalScore: number;
  sourcePaths: string[];
  topPositiveFactors: string[];
  topNegativeFactors: string[];
  explanation: string;
};

export function toLlmRankedCandidateView(ranked: RankedCandidate): LlmRankedCandidateView {
  return {
    trackId: ranked.score.trackId,
    title: ranked.candidate.playableTrack.title,
    artist: ranked.candidate.playableTrack.artist,
    album: ranked.candidate.playableTrack.album,
    totalScore: ranked.score.total,
    sourcePaths: ranked.score.sourcePaths,
    topPositiveFactors: getTopFactors(ranked.score.weighted, false),
    topNegativeFactors: getTopFactors(ranked.score.weighted, true),
    explanation: ranked.score.explanation
  };
}

export function validateLlmCandidateSelection(input: {
  selectedTrackId?: string;
  rankedCandidates: RankedCandidate[];
}) {
  const selected = input.rankedCandidates.find((candidate) => candidate.score.trackId === input.selectedTrackId);
  if (selected) {
    return { selected, reason: "LLM selected a valid ranked candidate." };
  }

  return {
    selected: input.rankedCandidates[0],
    reason: "LLM selected an invalid candidate; fell back to top-ranked candidate."
  };
}

export function parseLlmSelectionJson(content: string, rankedCandidates: RankedCandidate[]) {
  try {
    const parsed = JSON.parse(content) as { trackId?: string };
    return validateLlmCandidateSelection({ selectedTrackId: parsed.trackId, rankedCandidates });
  } catch {
    return {
      selected: rankedCandidates[0],
      reason: "LLM selection JSON parse failed; fell back to top-ranked candidate."
    };
  }
}

function getTopFactors(weighted: Record<string, number>, negative: boolean) {
  const keys = negative
    ? ["recentlyPlayedPenalty", "recentlySkippedPenalty", "sameArtistOverusePenalty", "overplayedTagPenalty", "lowConfidencePenalty"]
    : ["lastfmSimilarity", "seedWeight", "tagOverlap", "sourcePathStrength", "artistAffinity", "playableMatchConfidence", "novelty", "explorationBonus"];
  return keys
    .map((key) => ({ key, value: weighted[key] ?? 0 }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((item) => item.key);
}
