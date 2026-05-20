import type { RadioState } from "../types";
import type { TasteProfile } from "../taste";
import { explainScore } from "./explainScore";
import { DEFAULT_RECOMMENDER_WEIGHTS, SOURCE_PATH_WEIGHTS, type RecommenderWeights } from "./weights";
import { RECENCY_WINDOWS } from "./recencyWindows";
import type { SeedSource } from "./selectSeeds";

export type PlayableCandidate = {
  playableTrack: {
    id: string;
    source: string;
    title: string;
    artist: string;
    album?: string;
    durationMs?: number;
    artworkUrl?: string;
    playUrl?: string;
    playableId?: string;
    raw?: unknown;
  };
  infoTrack: {
    title: string;
    artist: string;
    album?: string;
    tags?: string[];
    mbid?: string;
    sourceProvider: string;
    raw?: unknown;
  };
  sourcePaths: string[];
  providerNames: string[];
  seedWeights: number[];
  similarityScores: number[];
  queryVariantWeights?: number[];
  seedSources?: SeedSource[];
  seedRefs?: Array<{ type: "track" | "artist" | "album"; title?: string; artist?: string; album?: string; source: SeedSource; weight: number }>;
  matchConfidence: number;
  versionFilter?: { allowed: boolean; penalty: number; reasons: string[] };
};

type ScoreFeatures = {
  lastfmSimilarity: number;
  seedWeight: number;
  tagOverlap: number;
  sourcePathStrength: number;
  artistAffinity: number;
  playableMatchConfidence: number;
  novelty: number;
  explorationBonus: number;
  multiSeedSupportBonus: number;
  recentlyPlayedPenalty: number;
  recentlySkippedPenalty: number;
  sameArtistOverusePenalty: number;
  overplayedTagPenalty: number;
  lowConfidencePenalty: number;
  seedDriftPenalty: number;
  previousTrackOnlyPenalty: number;
  versionPenalty: number;
};

export type CandidateScore = {
  trackId: string;
  total: number;
  sourcePaths: string[];
  providerNames: string[];
  features: ScoreFeatures;
  weighted: ScoreFeatures;
  explanation: string;
};

export type RankedCandidate = {
  candidate: PlayableCandidate;
  score: CandidateScore;
};

export function rankCandidates(input: {
  candidates: PlayableCandidate[];
  tasteProfile: TasteProfile;
  radioState: RadioState;
  exploration?: number;
  weights?: RecommenderWeights;
}): RankedCandidate[] {
  const weights = input.weights ?? DEFAULT_RECOMMENDER_WEIGHTS;
  const tasteTags = buildTasteTagWeights(input.tasteProfile, input.radioState);
  const recentTagStats = buildRecentTagStats(input.radioState);

  return input.candidates
    .filter((candidate) => candidate.matchConfidence >= 0.75)
    .map((candidate) => {
      const features: ScoreFeatures = {
        lastfmSimilarity: computeLastfmSimilarity(candidate),
        seedWeight: computeSeedWeight(candidate),
        tagOverlap: computeTagOverlap(candidate.infoTrack.tags ?? [], tasteTags),
        sourcePathStrength: computeSourcePathStrength(candidate.sourcePaths, input.tasteProfile.sourcePathTrust ?? input.radioState.sourcePathTrust),
        artistAffinity: computeArtistAffinity(candidate.playableTrack.artist, input.tasteProfile, input.radioState, candidate.sourcePaths),
        playableMatchConfidence: clamp01(candidate.matchConfidence),
        novelty: computeNovelty(findLastPlayedAt(candidate, input.radioState)),
        explorationBonus: computeExplorationBonus({
          candidate,
          tasteProfile: input.tasteProfile,
          radioState: input.radioState,
          exploration: input.exploration ?? input.tasteProfile.adaptive.exploration ?? input.radioState.adaptive?.exploration ?? 0.35
        }),
        multiSeedSupportBonus: computeMultiSeedSupportBonus(candidate),
        recentlyPlayedPenalty: computeRecentlyPlayedPenalty(findLastPlayedAt(candidate, input.radioState)),
        recentlySkippedPenalty: computeRecentlySkippedPenalty(candidate, input.radioState),
        sameArtistOverusePenalty: computeSameArtistOverusePenalty(candidate.playableTrack.artist, input.radioState),
        overplayedTagPenalty: computeOverplayedTagPenalty(candidate.infoTrack.tags ?? [], recentTagStats),
        lowConfidencePenalty: computeLowConfidencePenalty(candidate.matchConfidence),
        seedDriftPenalty: computeSeedDriftPenalty(candidate, input.radioState),
        previousTrackOnlyPenalty: computePreviousTrackOnlyPenalty(candidate),
        versionPenalty: candidate.versionFilter?.penalty ?? 0
      };
      const weighted: ScoreFeatures = {
        lastfmSimilarity: features.lastfmSimilarity * weights.lastfmSimilarity,
        seedWeight: features.seedWeight * weights.seedWeight,
        tagOverlap: features.tagOverlap * weights.tagOverlap,
        sourcePathStrength: features.sourcePathStrength * weights.sourcePathStrength,
        artistAffinity: features.artistAffinity * weights.artistAffinity,
        playableMatchConfidence: features.playableMatchConfidence * weights.playableMatchConfidence,
        novelty: features.novelty * weights.novelty,
        explorationBonus: features.explorationBonus * weights.explorationBonus,
        multiSeedSupportBonus: features.multiSeedSupportBonus * weights.multiSeedSupportBonus,
        recentlyPlayedPenalty: features.recentlyPlayedPenalty * weights.recentlyPlayedPenalty,
        recentlySkippedPenalty: features.recentlySkippedPenalty * weights.recentlySkippedPenalty,
        sameArtistOverusePenalty: features.sameArtistOverusePenalty * weights.sameArtistOverusePenalty,
        overplayedTagPenalty: features.overplayedTagPenalty * weights.overplayedTagPenalty,
        lowConfidencePenalty: features.lowConfidencePenalty * weights.lowConfidencePenalty,
        seedDriftPenalty: features.seedDriftPenalty * weights.seedDriftPenalty,
        previousTrackOnlyPenalty: features.previousTrackOnlyPenalty * weights.previousTrackOnlyPenalty,
        versionPenalty: features.versionPenalty * weights.versionPenalty
      };
      const total =
        weighted.lastfmSimilarity +
        weighted.seedWeight +
        weighted.tagOverlap +
        weighted.sourcePathStrength +
        weighted.artistAffinity +
        weighted.playableMatchConfidence +
        weighted.novelty +
        weighted.explorationBonus +
        weighted.multiSeedSupportBonus -
        weighted.recentlyPlayedPenalty -
        weighted.recentlySkippedPenalty -
        weighted.sameArtistOverusePenalty -
        weighted.overplayedTagPenalty -
        weighted.lowConfidencePenalty -
        weighted.seedDriftPenalty -
        weighted.previousTrackOnlyPenalty -
        weighted.versionPenalty;
      const score: CandidateScore = {
        trackId: candidate.playableTrack.id,
        total: Number(total.toFixed(3)),
        sourcePaths: candidate.sourcePaths,
        providerNames: candidate.providerNames,
        features,
        weighted,
        explanation: ""
      };
      score.explanation = explainScore(score);
      return { candidate, score };
    })
    .sort((a, b) => b.score.total - a.score.total);
}

export function computeLastfmSimilarity(candidate: PlayableCandidate): number {
  const effective = computeEffectiveLastfmSimilarity(candidate);
  if (candidate.sourcePaths.includes("lastfm:similar_track")) return effective || 0.3;
  if (candidate.sourcePaths.includes("lastfm:similar_artist:top_track")) return clamp01((effective || 0.3) * 0.85);
  if (candidate.sourcePaths.includes("fallback:lastfm:tag_top_track")) return Math.max(effective, 0.35);
  return effective || 0.25;
}

export function computeEffectiveLastfmSimilarity(candidate: PlayableCandidate): number {
  const weights = candidate.queryVariantWeights ?? [];
  const values = candidate.similarityScores.map((score, index) => score * (weights[index] ?? 1));
  return clamp01(Math.max(...values, 0));
}

export function computeSeedWeight(candidate: PlayableCandidate): number {
  if (!candidate.seedWeights.length) return 0.3;
  const max = Math.max(...candidate.seedWeights);
  const avg = candidate.seedWeights.reduce((sum, value) => sum + value, 0) / candidate.seedWeights.length;
  return clamp01(max * 0.7 + avg * 0.3);
}

export function computeTagOverlap(candidateTags: string[], tasteTags: Record<string, number>): number {
  return clamp01(candidateTags.map(normalizeTag).reduce((score, tag) => score + (tasteTags[tag] ?? 0), 0));
}

export function computeSourcePathStrength(sourcePaths: string[], sourcePathTrust: Record<string, number> = {}): number {
  const raw = sourcePaths.reduce((sum, path) => {
    const base = SOURCE_PATH_WEIGHTS[path] ?? 0.25;
    const trust = clamp(sourcePathTrust[path] ?? 1, 0.2, 1.2);
    return sum + base * trust;
  }, 0);
  return clamp01(raw / 1.8);
}

export function computeLowConfidencePenalty(matchConfidence: number): number {
  if (matchConfidence >= 0.9) return 0;
  if (matchConfidence >= 0.85) return 0.15;
  if (matchConfidence >= 0.75) return 0.45;
  return 1.0;
}


function computeMultiSeedSupportBonus(candidate: PlayableCandidate) {
  const baseSeedHits = new Set((candidate.seedRefs ?? [])
    .filter((seed) => seed.source === "base_library" || seed.source === "taste_profile" || seed.source === "pinned")
    .map((seed) => `${seed.type}:${seed.title ?? ""}:${seed.artist ?? ""}:${seed.album ?? ""}`));
  return clamp01((baseSeedHits.size - 1) / 3);
}

function computePreviousTrackOnlyPenalty(candidate: PlayableCandidate) {
  const sources = candidate.seedSources ?? [];
  if (sources.length === 0) return 0;
  return sources.every((source) => source === "previous_track_context") ? 1 : 0;
}

function computeSeedDriftPenalty(candidate: PlayableCandidate, state: RadioState) {
  const sources = candidate.seedSources ?? [];
  if (!sources.includes("previous_track_context")) return 0;
  const recentPreviousContextCount = state.playHistory
    .slice(-4)
    .filter((entry) => (entry.sourcePaths ?? []).includes("seed:previous_track_context"))
    .length;
  if (recentPreviousContextCount >= 3) return 1;
  if (recentPreviousContextCount === 2) return 0.6;
  if (recentPreviousContextCount === 1) return 0.25;
  return 0.15;
}
function computeArtistAffinity(artist: string, tasteProfile: TasteProfile, radioState: RadioState, sourcePaths: string[]): number {
  const normalizedArtist = normalizeArtist(artist);
  const direct = clamp01((radioState.artistWeights[normalizedArtist] ?? 0) / 2.5);
  const tasteBonus = tasteProfile.favoriteArtists.map(normalizeArtist).includes(normalizedArtist) ? 0.45 : 0;
  const similarArtistBonus = sourcePaths.includes("lastfm:similar_artist:top_track") ? 0.35 : 0;
  return clamp01(direct + tasteBonus + similarArtistBonus);
}

function computeNovelty(lastPlayedAt?: Date | null): number {
  if (!lastPlayedAt) return 1.0;
  const hours = hoursSince(lastPlayedAt);
  if (hours < RECENCY_WINDOWS.hardAvoidTrackHours) return 0.05;
  if (hours < RECENCY_WINDOWS.softAvoidTrackHours) return 0.2;
  if (hours < 168) return 0.45;
  if (hours < 720) return 0.7;
  return 0.9;
}

function computeRecentlyPlayedPenalty(lastPlayedAt?: Date | null): number {
  if (!lastPlayedAt) return 0;
  const hours = hoursSince(lastPlayedAt);
  if (hours < 6) return 1.0;
  if (hours < RECENCY_WINDOWS.hardAvoidTrackHours) return 0.8;
  if (hours < RECENCY_WINDOWS.softAvoidTrackHours) return 0.5;
  if (hours < 168) return 0.25;
  return 0;
}

function computeRecentlySkippedPenalty(candidate: PlayableCandidate, state: RadioState): number {
  const trackKey = normalizeKey(candidate.playableTrack.title, candidate.playableTrack.artist);
  const artist = normalizeArtist(candidate.playableTrack.artist);
  const tags = new Set((candidate.infoTrack.tags ?? []).map(normalizeTag));
  let penalty = 0;

  for (const skipped of state.skippedTracks.slice(0, 30)) {
    const normalized = skipped.toLowerCase();
    if (normalized.includes(trackKey)) penalty += 1.0;
    if (artist && normalized.includes(artist)) penalty += 0.7;
    for (const tag of tags) {
      if (tag && normalized.includes(tag)) penalty += 0.5;
    }
  }

  return clamp01(penalty);
}

function computeSameArtistOverusePenalty(artist: string, state: RadioState): number {
  const normalized = normalizeArtist(artist);
  if (!normalized) return 0;

  const recent = state.playHistory.slice(-RECENCY_WINDOWS.recentPlaysForArtistWindow);
  const reversedIndex = [...recent].reverse().findIndex((entry) => normalizeArtist(entry.artist) === normalized);
  const count = recent.filter((entry) => normalizeArtist(entry.artist) === normalized).length;

  if (reversedIndex >= 0 && reversedIndex < 5) return 1.0;
  if (reversedIndex >= 0) return 0.65;
  if (count >= 2) return 0.8;
  return 0;
}

function computeOverplayedTagPenalty(candidateTags: string[], recentTagStats: Record<string, number>): number {
  let penalty = 0;
  for (const tag of candidateTags.map(normalizeTag)) {
    const recentCount = recentTagStats[tag] ?? 0;
    if (recentCount >= 5) penalty += 0.4;
    if (recentCount >= 7) penalty += 0.7;
  }
  return clamp01(penalty);
}

function computeExplorationBonus(input: { candidate: PlayableCandidate; tasteProfile: TasteProfile; radioState: RadioState; exploration: number }) {
  const hasUserPlayedTrackBefore = Boolean(findLastPlayedAt(input.candidate, input.radioState));
  const isKnownArtist = input.tasteProfile.favoriteArtists.map(normalizeArtist).includes(normalizeArtist(input.candidate.playableTrack.artist));
  const newTrackBonus = hasUserPlayedTrackBefore ? 0 : 0.6;
  const newArtistBonus = isKnownArtist ? 0 : 0.4;
  return clamp01(input.exploration * (newTrackBonus + newArtistBonus));
}

function findLastPlayedAt(candidate: PlayableCandidate, state: RadioState) {
  const candidateTitle = normalizeText(candidate.playableTrack.title);
  const candidateArtist = normalizeArtist(candidate.playableTrack.artist);
  const found = [...state.playHistory].reverse().find((entry) => normalizeText(entry.title) === candidateTitle && normalizeArtist(entry.artist) === candidateArtist);
  return found?.playedAt ? new Date(found.playedAt) : null;
}

function buildTasteTagWeights(tasteProfile: TasteProfile, state: RadioState) {
  const weights: Record<string, number> = {};
  for (const tag of tasteProfile.favoriteGenres) weights[normalizeTag(tag)] = Math.max(weights[normalizeTag(tag)] ?? 0, 0.35);
  for (const tag of tasteProfile.favoriteMoods) weights[normalizeTag(tag)] = Math.max(weights[normalizeTag(tag)] ?? 0, 0.2);
  for (const [key, value] of Object.entries(state.keywordWeights)) weights[normalizeTag(key)] = clamp01(Math.max(0, value) / 3);
  for (const [key, value] of Object.entries(state.tagWeights ?? {})) weights[normalizeTag(key)] = clamp01(Math.max(0, value));
  return weights;
}

function buildRecentTagStats(state: RadioState) {
  const stats: Record<string, number> = {};
  for (const entry of state.playHistory.slice(-RECENCY_WINDOWS.recentPlaysForTagWindow)) {
    for (const tag of entry.tags ?? []) {
      const normalized = normalizeTag(tag);
      stats[normalized] = (stats[normalized] ?? 0) + 1;
    }
  }
  return stats;
}

function hoursSince(date: Date) {
  return (Date.now() - date.getTime()) / 36e5;
}

function normalizeKey(title: string, artist: string) {
  return `${normalizeText(title)}::${normalizeArtist(artist)}`;
}

function normalizeArtist(value: string) {
  return normalizeText(value);
}

function normalizeTag(value: string) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
