import type { CandidateScore } from "./rankCandidates";

export function explainScore(score: CandidateScore) {
  const positives = [
    score.features.lastfmSimilarity >= 0.65 ? "Last.fm similar-track or similar-artist relationship is strong" : "",
    score.features.sourcePathStrength >= 0.55 ? `candidate is supported by ${score.sourcePaths.join(" / ")}` : "",
    score.features.tagOverlap >= 0.35 ? "candidate tags overlap with the current taste profile" : "",
    score.features.artistAffinity >= 0.35 ? "artist affinity is positive from listening history or similar-artist path" : "",
    score.features.playableMatchConfidence >= 0.9 ? `playable provider match confidence is ${score.features.playableMatchConfidence.toFixed(2)}` : "",
    score.features.novelty >= 0.7 ? "track is fresh enough for the recent listening window" : "",
    score.features.multiSeedSupportBonus > 0 ? "candidate is supported by multiple base-library or taste-profile seeds" : ""
  ].filter(Boolean);

  const negatives = [
    score.features.recentlyPlayedPenalty > 0 ? "track or artist appeared recently, so repeat risk is penalized" : "",
    score.features.recentlySkippedPenalty > 0 ? "recent skip history overlaps with this track, artist or tags" : "",
    score.features.sameArtistOverusePenalty > 0 ? "same artist has appeared too often in the latest plays" : "",
    score.features.overplayedTagPenalty > 0 ? "some tags have been overrepresented recently" : "",
    score.features.lowConfidencePenalty > 0 ? "playable source match is acceptable but not high-confidence" : "",
    score.features.previousTrackOnlyPenalty > 0 ? "candidate only came from previous-track context, so chain drift is penalized" : "",
    score.features.seedDriftPenalty > 0 ? "recent recommendation history suggests seed drift, so this path is penalized" : "",
    score.features.versionPenalty > 0 ? "candidate title or album suggests remix, cover, live, DJ or another alternate version" : ""
  ].filter(Boolean);

  const plus = positives.length ? `Reasons: ${positives.join("; ")}.` : "Reasons: ranker found enough overall signal from Last.fm and playable matching.";
  const minus = negatives.length ? ` Penalties: ${negatives.join("; ")}.` : " Penalties: no major recent-play or confidence penalty.";
  return `${plus}${minus}`;
}


