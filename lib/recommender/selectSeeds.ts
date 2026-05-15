import type { PlaylistSong, RadioState } from "../types";

export type SeedSource = "base_library" | "taste_profile" | "pinned" | "recent_positive" | "liked_style" | "previous_track_context" | "exploration";

export type SeedIntent = "same_mood" | "similar_arrangement" | "same_era" | "same_scene" | "same_artist" | "same_album" | "explore_neighbor";

export type RecommendationSeed =
  | { type: "track"; title: string; artist: string; album?: string; mbid?: string; weight: number; source: SeedSource; intent?: SeedIntent; reason: string }
  | { type: "artist"; artist: string; mbid?: string; weight: number; source: SeedSource; intent?: SeedIntent; reason: string }
  | { type: "album"; artist: string; album: string; mbid?: string; weight: number; source: SeedSource; intent?: SeedIntent; reason: string };

export type SeedUsageEvent = {
  run_id?: string;
  seed_type: string;
  seed_title?: string | null;
  seed_artist?: string | null;
  seed_album?: string | null;
  seed_mbid?: string | null;
  source: SeedSource;
  weight: number;
  created_at: string;
};

export const SEED_SOURCE_WEIGHTS: Record<SeedSource, number> = {
  pinned: 1.2,
  base_library: 1.0,
  liked_style: 1.05,
  taste_profile: 0.95,
  recent_positive: 0.6,
  previous_track_context: 0.2,
  exploration: 0.55
};

export const SEED_SAMPLING_CONFIG = {
  seedCountPerRun: 3,
  recentSeedHardAvoidRuns: 2,
  recentSeedSoftAvoidRuns: 5,
  previousTrackMaxWeightShare: 0.15,
  baseSeedTemperature: 0.8
};

export const SEED_SAMPLING_MIX = {
  baseLibrary: 0.4,
  positiveFeedbackTracks: 0.25,
  similarTrackExpansion: 0.2,
  similarArtistDifferentArtist: 0.1,
  randomExploration: 0.05
};

export function selectSeeds(input: {
  playlist: PlaylistSong[];
  state: RadioState;
  limit?: number;
  recentSeedUsage?: SeedUsageEvent[];
  seedMode?: "base_random" | "continue_previous";
}): RecommendationSeed[] {
  const limit = input.limit ?? SEED_SAMPLING_CONFIG.seedCountPerRun;
  const seedMode = input.seedMode ?? "base_random";
  const candidates = buildSeedCandidates(input.playlist, input.state, seedMode);
  const deduped = dedupeSeeds(candidates).filter((seed) => !isRecentlySkipped(seed, input.state));
  const usage = input.recentSeedUsage ?? [];
  const hardAvoid = new Set(usage.slice(0, SEED_SAMPLING_CONFIG.recentSeedHardAvoidRuns).map(usageKey));
  const softAvoid = new Set(usage.slice(0, SEED_SAMPLING_CONFIG.recentSeedSoftAvoidRuns).map(usageKey));
  const primaryPool = deduped.filter((seed) => seed.source !== "previous_track_context" && !hardAvoid.has(seedKey(seed)));
  const fallbackPool = deduped.filter((seed) => !hardAvoid.has(seedKey(seed)));
  const pool = primaryPool.length >= limit ? primaryPool : fallbackPool.length ? fallbackPool : deduped;
  const sampled = weightedSample(pool, limit, (seed) => adjustedSeedWeight(seed, softAvoid, seedMode));

  if (seedMode === "continue_previous") return sampled;
  return ensureExplorationSeed(capPreviousTrackSeeds(sampled, deduped, limit), deduped, limit);
}

function buildSeedCandidates(playlist: PlaylistSong[], state: RadioState, seedMode: "base_random" | "continue_previous") {
  const seeds: RecommendationSeed[] = [];
  const baseSongs = shuffle(playlist).slice(0, 160);

  for (const song of baseSongs) {
    if (song.title && song.artist) seeds.push({ type: "track", title: song.title, artist: song.artist, album: song.album, weight: 0.78 * SEED_SOURCE_WEIGHTS.base_library, source: "base_library", intent: "explore_neighbor", reason: "weighted random sample from imported base library" });
    if (song.artist) seeds.push({ type: "artist", artist: song.artist, weight: 0.42 * SEED_SOURCE_WEIGHTS.base_library, source: "base_library", intent: "explore_neighbor", reason: "weighted random artist sample from imported base library" });
    if (song.album && song.artist) seeds.push({ type: "album", artist: song.artist, album: song.album, weight: 0.28 * SEED_SOURCE_WEIGHTS.base_library, source: "base_library", intent: "same_album", reason: "low-frequency album context from imported base library" });
  }

  for (const candidate of state.styleSeedCandidates ?? []) {
    if (candidate.title && candidate.artist) seeds.push({ type: "track", title: candidate.title, artist: candidate.artist, album: candidate.album, weight: clamp01(candidate.weight) * SEED_SOURCE_WEIGHTS.liked_style, source: "liked_style", intent: "same_mood", reason: "user clicked like this style; use as sound direction, not same-artist mandate" });
    if (candidate.artist) seeds.push({ type: "artist", artist: candidate.artist, weight: Math.min(0.22, clamp01(candidate.weight) * 0.18) * SEED_SOURCE_WEIGHTS.liked_style, source: "liked_style", intent: "explore_neighbor", reason: "weak artist context from liked style; prefer outward neighbors" });
    if (candidate.album && candidate.artist) seeds.push({ type: "album", artist: candidate.artist, album: candidate.album, weight: Math.min(0.18, clamp01(candidate.weight) * 0.14) * SEED_SOURCE_WEIGHTS.liked_style, source: "liked_style", intent: "same_album", reason: "very weak album context from liked style" });
  }

  const artistWeights = Object.entries(state.artistWeights ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 40);
  for (const [artist, weight] of artistWeights) {
    if (artist) seeds.push({ type: "artist", artist, weight: Math.min(0.58, clamp01(0.28 + Math.max(0, weight) / 8)) * SEED_SOURCE_WEIGHTS.taste_profile, source: "taste_profile", intent: "explore_neighbor", reason: "capped artist context from long-term Taste Profile" });
  }

  const recentPositive = [...state.playHistory].reverse().slice(1, 40);
  for (const entry of recentPositive) {
    if (entry.title && entry.artist) seeds.push({ type: "track", title: entry.title, artist: entry.artist, album: entry.album, weight: 0.36 * SEED_SOURCE_WEIGHTS.recent_positive, source: "recent_positive", intent: "same_mood", reason: "recent positive context, not primary chain seed" });
    if (entry.artist) seeds.push({ type: "artist", artist: entry.artist, weight: 0.12 * SEED_SOURCE_WEIGHTS.recent_positive, source: "recent_positive", intent: "explore_neighbor", reason: "weak recent artist context" });
  }

  const previous = state.playHistory.at(-1);
  if (previous?.title && previous.artist) {
    const multiplier = seedMode === "continue_previous" ? 1 : SEED_SOURCE_WEIGHTS.previous_track_context;
    seeds.push({ type: "track", title: previous.title, artist: previous.artist, album: previous.album, weight: 0.75 * multiplier, source: "previous_track_context", intent: seedMode === "continue_previous" ? "similar_arrangement" : "same_mood", reason: seedMode === "continue_previous" ? "explicit continue previous mode" : "previous track is continuity context only" });
  }

  return seeds;
}


function ensureExplorationSeed(sampled: RecommendationSeed[], all: RecommendationSeed[], limit: number) {
  if (sampled.some((seed) => seed.intent === "explore_neighbor" || seed.source === "exploration" || seed.source === "base_library")) return sampled;
  const replacement = all.find((seed) => (seed.intent === "explore_neighbor" || seed.source === "base_library") && !sampled.some((item) => seedKey(item) === seedKey(seed)));
  if (!replacement) return sampled;
  return [...sampled.slice(0, Math.max(0, limit - 1)), replacement].slice(0, limit);
}
function adjustedSeedWeight(seed: RecommendationSeed, softAvoid: Set<string>, seedMode: "base_random" | "continue_previous") {
  let weight = seed.weight;
  if (softAvoid.has(seedKey(seed))) weight *= 0.25;
  if (seed.source === "previous_track_context" && seedMode !== "continue_previous") weight *= 0.5;
  return Math.pow(Math.max(0.01, weight), 1 / SEED_SAMPLING_CONFIG.baseSeedTemperature);
}

function capPreviousTrackSeeds(sampled: RecommendationSeed[], all: RecommendationSeed[], limit: number) {
  const previous = sampled.filter((seed) => seed.source === "previous_track_context");
  if (previous.length === 0) return sampled;
  const total = sampled.reduce((sum, seed) => sum + seed.weight, 0);
  const previousTotal = previous.reduce((sum, seed) => sum + seed.weight, 0);
  if (total > 0 && previousTotal / total <= SEED_SAMPLING_CONFIG.previousTrackMaxWeightShare) return sampled;

  const replacements = all.filter((seed) => seed.source !== "previous_track_context" && !sampled.some((item) => seedKey(item) === seedKey(seed)));
  return [...sampled.filter((seed) => seed.source !== "previous_track_context"), ...weightedSample(replacements, Math.max(0, limit - sampled.filter((seed) => seed.source !== "previous_track_context").length), (seed) => seed.weight)].slice(0, limit);
}

function weightedSample<T>(items: T[], count: number, weightFor: (item: T) => number) {
  const remaining = [...items];
  const picked: T[] = [];
  while (remaining.length > 0 && picked.length < count) {
    const total = remaining.reduce((sum, item) => sum + Math.max(0.01, weightFor(item)), 0);
    let marker = Math.random() * total;
    const index = remaining.findIndex((item) => {
      marker -= Math.max(0.01, weightFor(item));
      return marker <= 0;
    });
    picked.push(...remaining.splice(index < 0 ? remaining.length - 1 : index, 1));
  }
  return picked;
}

function dedupeSeeds(seeds: RecommendationSeed[]) {
  const seen = new Set<string>();
  return seeds.filter((seed) => {
    const key = seedKey(seed);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecentlySkipped(seed: RecommendationSeed, state: RadioState) {
  const text = seedKey(seed);
  return state.skippedTracks.slice(0, 20).some((key) => key.includes(text));
}

export function seedKey(seed: RecommendationSeed) {
  if (seed.type === "track") return `track::${seed.title}::${seed.artist}`.toLowerCase();
  if (seed.type === "artist") return `artist::${seed.artist}`.toLowerCase();
  return `album::${seed.album}::${seed.artist}`.toLowerCase();
}

function usageKey(event: SeedUsageEvent) {
  if (event.seed_type === "track") return `track::${event.seed_title ?? ""}::${event.seed_artist ?? ""}`.toLowerCase();
  if (event.seed_type === "artist") return `artist::${event.seed_artist ?? ""}`.toLowerCase();
  return `album::${event.seed_album ?? ""}::${event.seed_artist ?? ""}`.toLowerCase();
}

function shuffle<T>(items: T[]) {
  return [...items].sort(() => Math.random() - 0.5);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}








