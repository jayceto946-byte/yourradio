import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadImportedPlaylist } from "./playlist";
import { buildTasteProfile, type TasteProfile } from "./taste";
import { generateDiscoveryPlan, getDiscoveryCandidatePool } from "./discovery";
import { markDiscoveryCandidateTried } from "./discovery/localDiscoveryCache";
import { rankCandidates, type PlayableCandidate, type RankedCandidate } from "./recommender/rankCandidates";
import { applyDiversityGuard } from "./recommender/diversityGuard";
import { selectSeeds, type RecommendationSeed, type SeedSource, SEED_SAMPLING_CONFIG } from "./recommender/selectSeeds";
import { getProviderOrder, searchSongsByProvider } from "./music";
import { filterTrackVersion } from "./recommender/filterTrackVersions";
import { getTrackKey, loadRadioState } from "./radioState";
import { listRecentSeedUsageEvents, saveRecommendationCandidates, saveSeedUsageEvents, saveTasteProfile } from "./db";
import type { CandidateDebug, DiscoveryDebug, PlaylistSong, RadioState, RecommendationFailure, SearchStrategy, Song, SourceSeed } from "./types";

const SEARCH_LIMIT = 3;
const RECENT_TRACK_LIMIT = 10;
const RECENT_ARTIST_LIMIT = 5;
const EXPANSION_SEED_LIMIT = 2;

const badVersionPatterns = [/karaoke/i, /\bktv\b/i, /\u4f34\u594f/i, /instrumental/i, /tribute/i, /\bcover\b/i, /\u7ffb\u5531/i, /originally performed by/i, /made famous by/i, /remix/i, /DJ\u7248/i, /slowed/i, /sped up/i, /nightcore/i, /\blive\b/i, /\u73b0\u573a/i, /\u73fe\u5834/i, /\u6f14\u5531\u4f1a/i, /\u6f14\u5531\u6703/i, /concert/i, /demo/i, /rehearsal/i, /piano version/i, /acoustic cover/i];
const hardRejectPatterns = [/karaoke/i, /\bktv\b/i, /\u4f34\u594f/i, /instrumental/i, /tribute/i, /originally performed by/i, /made famous by/i];
const livePatterns = [/\blive\b/i, /\u73b0\u573a/i, /\u73fe\u5834/i, /\u6f14\u5531\u4f1a/i, /\u6f14\u5531\u6703/i, /\bconcert\b/i, /\btour\b/i, /\bunplugged\b/i, /acoustic\s+live/i, /\bsession\b/i, /from the vault live/i, /at .+ live/i];

type SeedRef = { type: "track" | "artist" | "album"; title?: string; artist?: string; album?: string; source: SeedSource; weight: number };

type DiscoveryLikeCandidate = {
  title: string;
  artist: string;
  album?: string;
  tags?: string[];
  source: string;
  sourcePaths?: string[];
  seedWeights?: number[];
  similarityScores?: number[];
  queryVariantWeights?: number[];
};

export type PickNextTrackResult = {
  track: Song;
  searchQuery: string;
  searchStrategy: SearchStrategy;
  tasteKeywordsUsed: string[];
  sourceSeed: SourceSeed;
  reason: string;
  fallbackUsed: boolean;
  liveFilteredCount: number;
  livePenaltyApplied: boolean;
  providerTried: string[];
  selectedProvider: string;
  candidateDebug: CandidateDebug[];
  fallbackReason: string | null;
  discovery?: DiscoveryDebug;
  rankerSourcePaths?: string[];
  rankerScore?: number;
};

export async function pickPlayableBaseLibraryTrack(reason = "opening_base_library_fallback"): Promise<PickNextTrackResult> {
  const state = await loadRadioState();
  const playlist = await loadImportedPlaylist();
  const providerTried: string[] = [];
  const candidateDebug: CandidateDebug[] = [];
  const seeds = playlist
    .filter((song) => song.title && song.artist)
    .map((song) => ({ song, weight: Math.random() + (state.artistWeights[song.artist.toLowerCase()] ?? 0) * 0.05 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 16)
    .map((entry) => entry.song);

  for (const seed of seeds) {
    for (const provider of getPlayableProviderOrder()) {
      providerTried.push(provider);
      const songs = await searchPlayableSongVariants(provider, { title: seed.title, artist: seed.artist, album: seed.album, source: "manual" }).catch(() => []);
      const liveInfo = filterOrPenalizeLiveTracks(songs);
      const versionChecked = applyVersionFilter(liveInfo.tracks);
      const scored = scoreCandidates(versionChecked.tracks, seed, state, liveInfo.livePenaltyApplied);
      candidateDebug.push(...scored.slice(0, 4).map(({ song, score, rejectedReasons }) => ({ title: song.title, artist: song.artist, provider: song.platform, score, rejectedReasons })));

      const selected = scored.find((entry) => !entry.rejectedReasons.includes("hard_bad_version") && computePlayableMatchConfidence(entry.song, seed) >= 0.78);
      if (!selected) continue;

      return {
        track: selected.song,
        searchQuery: `${seed.title} ${seed.artist}`.trim(),
        searchStrategy: "exact",
        tasteKeywordsUsed: ["base_library", "opening_fallback"],
        sourceSeed: toSourceSeed(seed),
        reason: `Opening fallback used a real imported-library track because ${reason}.`,
        fallbackUsed: true,
        liveFilteredCount: liveInfo.liveFilteredCount,
        livePenaltyApplied: liveInfo.livePenaltyApplied,
        providerTried: unique(providerTried),
        selectedProvider: selected.song.platform || provider,
        candidateDebug: candidateDebug.slice(-24),
        fallbackReason: reason,
        rankerSourcePaths: ["base_library", "fallback:custom_search"],
        rankerScore: selected.score
      };
    }
  }

  throwRecommendationFailure("NO_PLAYABLE_CANDIDATES", "Opening fallback could not find a playable track in the imported library.", { providerTried: unique(providerTried), candidateDebug: candidateDebug.slice(-24) });
}
export class RecommendationFailureError extends Error {
  failure: RecommendationFailure;
  constructor(failure: RecommendationFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

export async function pickNextTrack(): Promise<PickNextTrackResult> {
  const startedAt = performance.now();
  try {
    const state = await loadRadioState();
    const playlist = await loadImportedPlaylist();
    const tasteProfile = buildTasteProfile(playlist);
    const recentSeedUsage = listRecentSeedUsageEvents(20);
    const seeds = selectSeeds({ playlist, state, limit: SEED_SAMPLING_CONFIG.seedCountPerRun, recentSeedUsage, seedMode: "base_random" });
    const candidateDebug: CandidateDebug[] = [];
    const providerTried: string[] = [];

    if (seeds.length === 0) {
      throwRecommendationFailure("NO_SEEDS", "No real seed tracks, artists or albums are available. Import listening history first.");
    }

    const runId = `recommend-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const expanded = await expandPlayableCandidatesForSeeds(seeds.slice(0, EXPANSION_SEED_LIMIT), tasteProfile, state, providerTried, candidateDebug);

    if (!expanded.sawLastFmResults) {
      throwRecommendationFailure("LASTFM_NO_RESULTS", "Last.fm returned no entity-based candidates for the selected base seeds.", { seeds, seedMode: "base_random", recentSeedUsage });
    }
    if (!expanded.sawPlayableCandidates) {
      throwRecommendationFailure("NO_PLAYABLE_CANDIDATES", "Last.fm returned candidates, but none could be matched by CustomMusicProvider.", { seeds, providerTried: unique(providerTried), candidateDebug: candidateDebug.slice(-24) });
    }

    const rankedBeforeDiversity = rankCandidates({ candidates: expanded.playableCandidates, tasteProfile, radioState: state, exploration: state.adaptive?.exploration ?? tasteProfile.adaptive.exploration });
    const diversity = applyDiversityGuard({ candidates: rankedBeforeDiversity, radioState: state, currentQueue: await loadQueueForDiversity() });
    const ranked = diversity.candidates;
    try {
      saveRecommendationCandidates(runId, ranked.slice(0, 30));
      saveSeedUsageEvents(runId, seeds);
      saveTasteProfile(tasteProfile);
    } catch {}

    const selected = pickRankedCandidate(ranked.slice(0, 8));
    if (!selected) {
      throwRecommendationFailure("RANKER_EMPTY", "Playable candidates were found, but the Ranker produced no selectable candidate.", { seeds, candidateDebug: candidateDebug.slice(-24) });
    }

    const sourceCandidate = expanded.discoveryCandidates.find((candidate) => normalizeText(`${candidate.title} ${candidate.artist}`) === normalizeText(`${selected.candidate.infoTrack.title} ${selected.candidate.infoTrack.artist}`));
    if (sourceCandidate) {
      await markDiscoveryCandidateTried(sourceCandidate, { playableVerified: true, providerMatched: selected.candidate.playableTrack.source, unavailableCount: 0 }).catch(() => undefined);
    }

    return toPickResult({ selected, seeds, providerTried, candidateDebug, expanded });
  } finally {
    if (process.env.NODE_ENV === "development") console.log(`[perf] recommendNextTrack: ${Math.round(performance.now() - startedAt)}ms`);
  }
}

async function expandPlayableCandidatesForSeeds(seeds: RecommendationSeed[], tasteProfile: TasteProfile, state: RadioState, providerTried: string[], candidateDebug: CandidateDebug[]) {
  const playableCandidates: PlayableCandidate[] = [];
  const discoveryCandidates: Array<DiscoveryLikeCandidate & { seedSource: SeedSource; seedRef: SeedRef }> = [];
  const queriesUsed: string[] = [];
  let sawLastFmResults = false;

  const groups = await Promise.all(seeds.map(async (seed) => {
    const seedSong = seedToPlaylistSong(seed);
    const plan = await generateDiscoveryPlan({ sourceSeed: seedSong, tasteProfile, recentTracks: state.recentTracks, recentSkippedTracks: state.skippedTracks, likedTracks: state.likedTracks, timeOfDay: getTimeOfDay(), mode: "similarSongs" }).catch(() => undefined);
    if (!plan || plan.candidateSongs.length === 0) return [];
    const pool = await getDiscoveryCandidatePool(plan, 6).catch(() => plan.candidateSongs);
    const seedRef = toSeedRef(seed);
    return pool.map((candidate) => ({ ...candidate, seedSource: seed.source, seedRef }));
  }));

  const merged = mergeDiscoveryCandidates(groups.flat());
  if (merged.length > 0) sawLastFmResults = true;
  discoveryCandidates.push(...merged);

  for (const discoveryCandidate of merged.slice(0, 6)) {
    const query = `${discoveryCandidate.title} ${discoveryCandidate.artist}`.trim();
    queriesUsed.push(query);
    playableCandidates.push(...await findPlayableMatchesForDiscoveryCandidate({ discoveryCandidate, query, state, providerTried, candidateDebug }));
    if (playableCandidates.length >= 8) break;
  }

  return {
    sawLastFmResults,
    sawPlayableCandidates: playableCandidates.length > 0,
    playableCandidates,
    discoveryCandidates,
    queriesUsed
  };
}

async function findPlayableMatchesForDiscoveryCandidate(input: { discoveryCandidate: DiscoveryLikeCandidate & { seedSource: SeedSource; seedRef: SeedRef; seedRefs?: SeedRef[]; seedSources?: SeedSource[] }; query: string; state: RadioState; providerTried: string[]; candidateDebug: CandidateDebug[] }): Promise<PlayableCandidate[]> {
  const playableCandidates: PlayableCandidate[] = [];
  const seedForScoring: PlaylistSong = { title: input.discoveryCandidate.title, artist: input.discoveryCandidate.artist, album: input.discoveryCandidate.album ?? "", duration: "" };

  for (const provider of getPlayableProviderOrder()) {
    input.providerTried.push(provider);
    const songs = await searchPlayableSongVariants(provider, input.discoveryCandidate).catch(() => []);
    const liveInfo = filterOrPenalizeLiveTracks(songs);
    const versionChecked = applyVersionFilter(liveInfo.tracks);
    const scored = scoreCandidates(versionChecked.tracks, seedForScoring, input.state, liveInfo.livePenaltyApplied);
    input.candidateDebug.push(...scored.slice(0, 6).map(({ song, score, rejectedReasons }) => ({ title: song.title, artist: song.artist, provider: song.platform, score, rejectedReasons })));

    for (const entry of scored.slice(0, 3)) {
      const versionFilter = filterTrackVersion({ title: entry.song.title, artist: entry.song.artist, album: entry.song.album });
      if (entry.rejectedReasons.includes("hard_bad_version")) continue;
      const matchConfidence = Math.max(0, computePlayableMatchConfidence(entry.song, seedForScoring) - versionFilter.penalty * 0.2);
      if (matchConfidence < 0.75) continue;
      const seedSources = input.discoveryCandidate.seedSources?.length ? input.discoveryCandidate.seedSources : [input.discoveryCandidate.seedSource];
      const seedRefs = input.discoveryCandidate.seedRefs?.length ? input.discoveryCandidate.seedRefs : [input.discoveryCandidate.seedRef];
      playableCandidates.push({
        playableTrack: { id: entry.song.id, source: entry.song.platform || provider, title: entry.song.title, artist: entry.song.artist, album: entry.song.album, durationMs: entry.song.durationSeconds ? entry.song.durationSeconds * 1000 : undefined, artworkUrl: entry.song.coverUrl, playUrl: entry.song.audioUrl, playableId: entry.song.id, raw: entry.song },
        infoTrack: { title: input.discoveryCandidate.title, artist: input.discoveryCandidate.artist, album: input.discoveryCandidate.album, tags: input.discoveryCandidate.tags ?? [], sourceProvider: input.discoveryCandidate.source, raw: input.discoveryCandidate },
        sourcePaths: unique([...(input.discoveryCandidate.sourcePaths?.length ? input.discoveryCandidate.sourcePaths : ["fallback:custom_search"]), ...seedSources.map((source) => `seed:${source}`)]),
        providerNames: [entry.song.platform || provider],
        seedWeights: input.discoveryCandidate.seedWeights?.length ? input.discoveryCandidate.seedWeights : seedRefs.map((seed) => seed.weight),
        similarityScores: input.discoveryCandidate.similarityScores?.length ? input.discoveryCandidate.similarityScores : [0.3],
        queryVariantWeights: input.discoveryCandidate.queryVariantWeights,
        seedSources,
        seedRefs,
        matchConfidence,
        versionFilter
      });
    }
  }
  return playableCandidates;
}


async function searchPlayableSongVariants(provider: string, candidate: DiscoveryLikeCandidate) {
  const queries = unique([
    `${candidate.title} ${candidate.artist}`.trim(),
    candidate.title,
    `${candidate.artist} ${candidate.title}`.trim()
  ]).filter(Boolean);

  for (const keyword of queries) {
    const songs = await searchSongsByProvider(provider, { keyword, limit: SEARCH_LIMIT }).catch(() => []);
    if (songs.length > 0) return songs;
  }

  return [];
}

async function loadQueueForDiversity() {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "player", "rolling-queue-snapshot.json"), "utf8");
    const parsed = JSON.parse(raw) as { queue?: Array<{ status?: string; item?: { track?: { title?: string; artist?: string; album?: string }; rankerSourcePaths?: string[] } }> };
    return parsed.queue ?? [];
  } catch {
    return [];
  }
}
function toPickResult(input: { selected: RankedCandidate; seeds: RecommendationSeed[]; providerTried: string[]; candidateDebug: CandidateDebug[]; expanded: Awaited<ReturnType<typeof expandPlayableCandidatesForSeeds>> }): PickNextTrackResult {
  const pickedTrack = toSongFromPlayableCandidate(input.selected.candidate);
  const seedSong = seedToPlaylistSong(input.seeds[0]);
  const discoveryDebug: DiscoveryDebug = {
    source: "lastfm",
    searchIntent: `seedMode=base_random; expanded ${input.seeds.length} base/taste seeds through Last.fm entity graph`,
    queriesUsed: input.expanded.queriesUsed.slice(0, 16),
    candidateSongs: input.expanded.discoveryCandidates.slice(0, 8).map((candidate) => ({ title: candidate.title, artist: candidate.artist, source: candidate.source, confidence: "medium" }))
  };

  return {
    track: pickedTrack,
    searchQuery: `${input.selected.candidate.infoTrack.title} ${input.selected.candidate.infoTrack.artist}`.trim(),
    searchStrategy: "discovery",
    tasteKeywordsUsed: unique([...(input.selected.candidate.infoTrack.tags ?? []), ...input.selected.candidate.sourcePaths]).slice(0, 10),
    sourceSeed: toSourceSeed(seedSong),
    reason: `SeedMode base_random. Used seeds: ${input.seeds.map(describeSeed).join("; ")}. Ranker score ${input.selected.score.total}: ${input.selected.score.explanation}`,
    fallbackUsed: false,
    liveFilteredCount: 0,
    livePenaltyApplied: false,
    providerTried: unique(input.providerTried),
    selectedProvider: input.selected.candidate.playableTrack.source,
    candidateDebug: input.candidateDebug.slice(-24),
    fallbackReason: null,
    rankerSourcePaths: input.selected.candidate.sourcePaths,
    rankerScore: input.selected.score.total,
    discovery: discoveryDebug
  };
}

function mergeDiscoveryCandidates(candidates: Array<DiscoveryLikeCandidate & { seedSource: SeedSource; seedRef: SeedRef }>) {
  const byKey = new Map<string, DiscoveryLikeCandidate & { seedSource: SeedSource; seedRef: SeedRef; seedSources: SeedSource[]; seedRefs: SeedRef[] }>();
  for (const candidate of candidates) {
    const key = normalizeText(`${candidate.title} ${candidate.artist}`);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...candidate, seedSources: [candidate.seedSource], seedRefs: [candidate.seedRef] });
      continue;
    }
    existing.sourcePaths = unique([...(existing.sourcePaths ?? []), ...(candidate.sourcePaths ?? [])]);
    existing.seedWeights = [...(existing.seedWeights ?? []), ...(candidate.seedWeights ?? []), candidate.seedRef.weight];
    existing.similarityScores = [...(existing.similarityScores ?? []), ...(candidate.similarityScores ?? [])];
    existing.queryVariantWeights = [...(existing.queryVariantWeights ?? []), ...(candidate.queryVariantWeights ?? [])];
    existing.tags = unique([...(existing.tags ?? []), ...(candidate.tags ?? [])]);
    existing.seedSources = unique([...existing.seedSources, candidate.seedSource]) as SeedSource[];
    existing.seedRefs = [...existing.seedRefs, candidate.seedRef];
  }
  return [...byKey.values()];
}


function applyVersionFilter(tracks: Song[]) {
  const checked = tracks.map((track) => ({ track, versionFilter: filterTrackVersion({ title: track.title, artist: track.artist, album: track.album }) }));
  const allowed = checked.filter((entry) => entry.versionFilter.allowed);
  return { tracks: (allowed.length ? allowed : checked).map((entry) => entry.track) };
}
export function isLiveVersion(track: Song) { return livePatterns.some((pattern) => pattern.test(getVersionText(track))); }
export function filterOrPenalizeLiveTracks(tracks: Song[]) {
  const liveTracks = tracks.filter(isLiveVersion);
  const studioTracks = tracks.filter((track) => !isLiveVersion(track));
  if (studioTracks.length >= 3) return { tracks: studioTracks, liveFilteredCount: liveTracks.length, livePenaltyApplied: false };
  return { tracks, liveFilteredCount: 0, livePenaltyApplied: liveTracks.length > 0 };
}

export function scoreTrackCandidate(song: Song, seed: PlaylistSong, state: RadioState, livePenaltyApplied: boolean) {
  const rejectedReasons: string[] = [];
  const normalizedSeedTitle = normalizeTitle(seed.title);
  const normalizedSongTitle = normalizeTitle(song.title);
  const artistMatch = getArtistMatchScore(song.artist, seed.artist);
  let score = 20;
  if (!song.audioUrl) { rejectedReasons.push("not_playable"); score -= 80; }
  if (normalizedSeedTitle && normalizedSongTitle === normalizedSeedTitle) score += 38;
  else if (normalizedSeedTitle && (normalizedSongTitle.includes(normalizedSeedTitle) || normalizedSeedTitle.includes(normalizedSongTitle))) score += 22;
  else if (normalizedSeedTitle) { score -= 12; rejectedReasons.push("title_mismatch"); }
  score += artistMatch.score;
  if (artistMatch.reason) rejectedReasons.push(artistMatch.reason);
  const versionText = getVersionText(song);
  if (hardRejectPatterns.some((pattern) => pattern.test(versionText))) { score -= 90; rejectedReasons.push("hard_bad_version"); }
  else if (badVersionPatterns.some((pattern) => pattern.test(versionText))) { score -= isLiveVersion(song) && livePenaltyApplied ? 40 : 30; rejectedReasons.push(isLiveVersion(song) ? "live" : "bad_version"); }
  if (state.recentTracks.slice(0, RECENT_TRACK_LIMIT).includes(getTrackKey(song.id, song.title, song.artist))) { score -= 40; rejectedReasons.push("recent_track"); }
  if (getRecentArtists(state, RECENT_ARTIST_LIMIT).includes(song.artist.toLowerCase())) { score -= 18; rejectedReasons.push("artist_cooldown"); }
  score += clamp(state.artistWeights[song.artist.toLowerCase()] ?? 0, -2.5, 2.5) * 4;
  return { song, score: Math.round(score), rejectedReasons };
}

function scoreCandidates(songs: Song[], seed: PlaylistSong, state: RadioState, livePenaltyApplied: boolean) { return songs.map((song) => scoreTrackCandidate(song, seed, state, livePenaltyApplied)).sort((a, b) => b.score - a.score); }
function getPlayableProviderOrder() { return getProviderOrder().filter((provider) => ["netease", "spotify", "tencent", "apple"].includes(provider) || process.env[`${provider.toUpperCase()}_API_KEY`] || process.env[`${provider.toUpperCase()}_API_BASE_URL`]).slice(0, 4); }
function computePlayableMatchConfidence(song: Song, seed: PlaylistSong) { const titleScore = getTitleMatchConfidence(song.title, seed.title); const artistScore = Math.max(0, Math.min(1, (getArtistMatchScore(song.artist, seed.artist).score + 30) / 64)); const albumScore = seed.album && normalizeText(song.album) === normalizeText(seed.album) ? 0.05 : 0; return clamp(titleScore * 0.6 + artistScore * 0.35 + albumScore, 0, 1); }
function getTitleMatchConfidence(title: string, seedTitle: string) { const normalizedTitle = normalizeTitle(title); const normalizedSeed = normalizeTitle(seedTitle); if (!normalizedSeed) return 0.7; if (normalizedTitle === normalizedSeed) return 1; if (normalizedTitle.includes(normalizedSeed) || normalizedSeed.includes(normalizedTitle)) return 0.82; return 0.45; }
function pickRankedCandidate(ranked: RankedCandidate[]) { return weightedPick(ranked, (entry) => Math.max(0.1, entry.score.total + 6)); }
function toSongFromPlayableCandidate(candidate: PlayableCandidate): Song { return { id: candidate.playableTrack.id, title: candidate.playableTrack.title, artist: candidate.playableTrack.artist, album: candidate.playableTrack.album ?? "Unknown Album", durationSeconds: candidate.playableTrack.durationMs ? Math.round(candidate.playableTrack.durationMs / 1000) : 0, audioUrl: candidate.playableTrack.playUrl ?? "", platform: candidate.playableTrack.source, coverUrl: candidate.playableTrack.artworkUrl }; }
function seedToPlaylistSong(seed: RecommendationSeed): PlaylistSong { if (seed.type === "track") return { title: seed.title, artist: seed.artist, album: seed.album ?? "", duration: "" }; if (seed.type === "artist") return { title: "", artist: seed.artist, album: "", duration: "" }; return { title: "", artist: seed.artist, album: seed.album, duration: "" }; }
function toSeedRef(seed: RecommendationSeed): SeedRef { return seed.type === "track" ? { type: "track", title: seed.title, artist: seed.artist, album: seed.album, source: seed.source, weight: seed.weight } : seed.type === "artist" ? { type: "artist", artist: seed.artist, source: seed.source, weight: seed.weight } : { type: "album", artist: seed.artist, album: seed.album, source: seed.source, weight: seed.weight }; }
function describeSeed(seed: RecommendationSeed) { return `${seed.type}:${seed.type === "track" ? `${seed.title} - ${seed.artist}` : seed.type === "artist" ? seed.artist : `${seed.album} - ${seed.artist}`} [${seed.source}]`; }
function getArtistMatchScore(trackArtist: string, seedArtist: string) { const track = normalizeText(trackArtist); const seed = normalizeText(seedArtist); if (!seed) return { score: 8, reason: "" }; if (track === seed) return { score: 34, reason: "" }; if (track.includes(seed) || seed.includes(track)) return { score: 26, reason: "" }; const seedParts = seed.split(/[,/&、和 ]+/).filter(Boolean); if (seedParts.some((part) => track.includes(part))) return { score: 22, reason: "" }; return { score: -30, reason: "artist_mismatch" }; }
function getTimeOfDay() { const hour = new Date().getHours(); if (hour < 6) return "late night"; if (hour < 11) return "morning"; if (hour < 14) return "noon"; if (hour < 18) return "afternoon"; if (hour < 22) return "night"; return "late night"; }
function normalizeTitle(value: string) { return normalizeText(value).replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "").replace(/feat\..*$/i, "").replace(/ft\..*$/i, "").trim(); }
function normalizeText(value: string) { return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function getVersionText(song: Song) { return `${song.title} ${song.album} ${song.artist}`; }
function getRecentArtists(state: RadioState, limit: number) { return state.playHistory.slice(-limit).map((entry) => entry.artist.toLowerCase()).filter(Boolean); }
function toSourceSeed(seed: PlaylistSong): SourceSeed { return { title: seed.title, artist: seed.artist, album: seed.album }; }
function throwRecommendationFailure(code: RecommendationFailure["code"], message: string, debug?: unknown): never { throw new RecommendationFailureError({ ok: false, code, message, debug }); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function unique(values: string[]) { return Array.from(new Set(values.filter(Boolean))); }
function weightedPick<T>(items: T[], weightFor: (item: T) => number) { if (items.length === 0) return undefined; const weighted = items.map((item) => ({ item, weight: Math.max(0.01, weightFor(item)) })); const total = weighted.reduce((sum, entry) => sum + entry.weight, 0); let marker = Math.random() * total; for (const entry of weighted) { marker -= entry.weight; if (marker <= 0) return entry.item; } return weighted[weighted.length - 1]?.item; }








