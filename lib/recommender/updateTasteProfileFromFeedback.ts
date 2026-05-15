import type { RadioNextResponse, RadioState } from "../types";
import { RECENCY_WINDOWS } from "./recencyWindows";
import { updateExploration } from "./updateExploration";

export type FeedbackEvent = "play_start" | "play_end" | "skip" | "replay" | "like" | "like_style" | "dislike";

export function updateTasteProfileFromFeedback(input: {
  state: RadioState;
  item: RadioNextResponse;
  event: FeedbackEvent;
  completionRate?: number;
  skippedBeforeMs?: number;
}) {
  const { state, item, event } = input;
  state.tagWeights ??= {};
  state.sourcePathWeights ??= {};
  state.sourcePathTrust ??= {};
  state.shortTerm ??= { artistWeights: {}, tagWeights: {}, skippedArtists: {}, skippedTags: {} };
  state.adaptive ??= { exploration: 0.35, weights: {} };
  state.styleSeedCandidates ??= [];
  state.tasteProfileDirty ??= false;

  const tags = item.tasteKeywordsUsed ?? [];
  const sourcePaths = getSourcePaths(item);
  const positive = event === "like" || event === "like_style" || event === "replay" || (event === "play_end" && (input.completionRate ?? 0) >= RECENCY_WINDOWS.strongCompletionRate);
  const strongPositive = event === "like" || event === "like_style" || event === "replay";
  const quickNegative = (input.skippedBeforeMs ?? Infinity) <= RECENCY_WINDOWS.quickSkipMs;
  const negative = event === "dislike" || event === "skip" || (event === "play_end" && (input.completionRate ?? 1) < RECENCY_WINDOWS.negativeCompletionRate) || quickNegative;

  if (positive) {
    const artistDelta = event === "like_style" ? 0.08 : event === "replay" || event === "like" ? 0.1 : 0.02;
    const tagDelta = event === "like_style" ? 0.06 : strongPositive ? 0.05 : 0.025;
    const sourceDelta = event === "like_style" ? 0.04 : strongPositive ? 0.035 : 0.02;
    adjustWeight(state.artistWeights, item.track.artist, artistDelta, 2.0);
    for (const tag of tags) adjustWeight(state.tagWeights, tag, tagDelta, 1.5);
    for (const path of sourcePaths) {
      adjustWeight(state.sourcePathWeights, path, sourceDelta, 1.5);
      adjustTrust(state.sourcePathTrust, path, event === "like_style" ? 0.04 : strongPositive ? 0.04 : 0.02);
    }
    if (event === "like_style") {
      addOrUpdateStyleSeedCandidate(state, item, tags, sourcePaths);
      adjustWeight(state.albumWeights ??= {}, item.track.album, 0.03, 1.0);
      state.tasteProfileDirty = true;
    }
    updateExploration({ state, eventType: event === "replay" ? "replay" : "play_end", isNewTrack: true, completionRate: input.completionRate ?? 1 });
  }

  if (negative) {
    adjustWeight(state.artistWeights, item.track.artist, -0.08, 2.5);
    adjustWeight(state.shortTerm.artistWeights, item.track.artist, -0.08, 1.5);
    adjustWeight(state.shortTerm.skippedArtists, item.track.artist, 0.2, 2);
    for (const tag of tags) {
      adjustWeight(state.tagWeights, tag, -0.05, 1.5);
      adjustWeight(state.shortTerm.tagWeights, tag, -0.05, 1.5);
      adjustWeight(state.shortTerm.skippedTags, tag, 0.15, 2);
    }
    for (const path of sourcePaths) {
      adjustWeight(state.sourcePathWeights, path, -0.03, 1.5);
      adjustTrust(state.sourcePathTrust, path, -0.04);
    }
    updateExploration({ state, eventType: "skip", isNewTrack: true, completionRate: input.completionRate ?? 0 });
  }

  return state;
}


function addOrUpdateStyleSeedCandidate(state: RadioState, item: RadioNextResponse, tags: string[], sourcePaths: string[]) {
  const now = new Date().toISOString();
  const existing = state.styleSeedCandidates?.find((candidate) => candidate.trackId === item.track.id || (candidate.title.toLowerCase() === item.track.title.toLowerCase() && candidate.artist.toLowerCase() === item.track.artist.toLowerCase()));
  if (existing) {
    existing.weight = Math.min(1.5, existing.weight + 0.12);
    existing.tags = unique([...(existing.tags ?? []), ...tags]);
    existing.sourcePaths = unique([...(existing.sourcePaths ?? []), ...sourcePaths]);
    existing.updatedAt = now;
    return;
  }

  state.styleSeedCandidates = [{
    trackId: item.track.id,
    title: item.track.title,
    artist: item.track.artist,
    album: item.track.album,
    tags,
    sourcePaths,
    weight: 0.92,
    createdAt: now,
    updatedAt: now,
    reason: "like_style" as const
  }, ...(state.styleSeedCandidates ?? [])].slice(0, 80);
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
function getSourcePaths(item: RadioNextResponse) {
  const fromDebug = item.rankerSourcePaths ?? [];
  if (fromDebug.length) return fromDebug;
  if (item.discovery?.source === "lastfm") return ["lastfm:similar_track"];
  return ["fallback:custom_search"];
}

function adjustTrust(map: Record<string, number>, rawKey: string, delta: number) {
  const key = rawKey.trim().toLowerCase();
  if (!key) return;
  map[key] = Math.max(0.2, Math.min(1.2, (map[key] ?? 1) + delta));
}

function adjustWeight(map: Record<string, number>, rawKey: string, delta: number, cap: number) {
  const key = rawKey.trim().toLowerCase();
  if (!key) return;
  map[key] = Math.max(-cap, Math.min(cap, (map[key] ?? 0) + delta));
}



