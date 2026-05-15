import type { RadioState } from "../types";
import type { RankedCandidate } from "./rankCandidates";

export type CandidateSourcePath =
  | "similar_track_different_artist"
  | "similar_track_same_artist"
  | "similar_artist_representative"
  | "same_artist_top_tracks"
  | "same_album_other_tracks"
  | "base_library"
  | "random_exploration";

export type DiversityGuardConfig = typeof DIVERSITY_GUARD_CONFIG;

export type DiversityGuardPenalty = {
  candidateId: string;
  candidate: string;
  artist: string;
  penaltyType: string;
  amount: number;
  reason: string;
};

export type DiversityGuardBonus = {
  candidateId: string;
  candidate: string;
  artist: string;
  bonusType: string;
  amount: number;
  reason: string;
};

export type DiversityGuardInput = {
  candidates: RankedCandidate[];
  radioState: RadioState;
  currentQueue?: Array<{ status?: string; item?: { track?: { title?: string; artist?: string; album?: string }; rankerSourcePaths?: string[] } }>;
  config?: Partial<DiversityGuardConfig>;
};

export type DiversityGuardOutput = {
  candidates: RankedCandidate[];
  penaltiesApplied: DiversityGuardPenalty[];
  bonusesApplied: DiversityGuardBonus[];
  explorationSlots: number;
};

export const DIVERSITY_GUARD_CONFIG = {
  recentArtistWindow: 5,
  recentAlbumWindow: 10,
  queueArtistWindow: 3,
  sameArtistRecentPenalty: 1.8,
  sameAlbumRecentPenalty: 1.0,
  sameArtistInQueuePenalty: 1.25,
  sameSeedClusterPenalty: 0.75,
  sameSourcePathOverusePenalty: 1.0,
  artistOverfitPenalty: 1.35,
  similarTrackDifferentArtistBonus: 0.45,
  explorationBonus: 0.32,
  newArtistBonus: 0.22,
  maxSameArtistInQueue: 1,
  maxSameAlbumInQueue: 1,
  minExplorationSlotsInNext3: 1,
  explorationScoreFloor: 0.45
};

let lastDiversityDebug: (DiversityGuardOutput & { beforeDiversityGuard: RankedCandidate[]; recentArtists: string[]; recentAlbums: string[] }) | null = null;

export function applyDiversityGuard(input: DiversityGuardInput): DiversityGuardOutput {
  const config = { ...DIVERSITY_GUARD_CONFIG, ...(input.config ?? {}) };
  const recent = input.radioState.playHistory ?? [];
  const recentArtists = recent.slice(-config.recentArtistWindow).map((entry) => normalize(entry.artist));
  const recentAlbums = recent.slice(-config.recentAlbumWindow).map((entry) => normalizeAlbum(entry.album, entry.artist));
  const recentSourcePaths = recent.slice(-config.recentArtistWindow).flatMap((entry) => entry.sourcePaths ?? []);
  const queueArtists = (input.currentQueue ?? [])
    .filter((slot) => slot.status !== "played" && slot.status !== "failed" && slot.status !== "stale")
    .slice(0, config.queueArtistWindow)
    .map((slot) => normalize(slot.item?.track?.artist ?? ""))
    .filter(Boolean);
  const queueAlbums = (input.currentQueue ?? [])
    .filter((slot) => slot.status !== "played" && slot.status !== "failed" && slot.status !== "stale")
    .slice(0, config.queueArtistWindow)
    .map((slot) => normalizeAlbum(slot.item?.track?.album, slot.item?.track?.artist))
    .filter(Boolean);

  const penaltiesApplied: DiversityGuardPenalty[] = [];
  const bonusesApplied: DiversityGuardBonus[] = [];

  const adjusted = input.candidates.map((entry) => {
    const candidate = entry.candidate;
    const artist = normalize(candidate.playableTrack.artist);
    const album = normalizeAlbum(candidate.playableTrack.album, candidate.playableTrack.artist);
    const sourceKind = classifyCandidateSourcePath(candidate);
    let delta = 0;

    function penalty(penaltyType: string, amount: number, reason: string) {
      delta -= amount;
      penaltiesApplied.push({ candidateId: entry.score.trackId, candidate: display(entry), artist: candidate.playableTrack.artist, penaltyType, amount, reason });
    }

    function bonus(bonusType: string, amount: number, reason: string) {
      delta += amount;
      bonusesApplied.push({ candidateId: entry.score.trackId, candidate: display(entry), artist: candidate.playableTrack.artist, bonusType, amount, reason });
    }

    if (artist && recentArtists.includes(artist)) penalty("sameArtistRecentPenalty", config.sameArtistRecentPenalty, "artist appeared in recent playback window");
    if (album && recentAlbums.includes(album)) penalty("sameAlbumRecentPenalty", config.sameAlbumRecentPenalty, "album appeared in recent playback window");
    if (artist && queueArtists.filter((value) => value === artist).length >= config.maxSameArtistInQueue) penalty("sameArtistInQueuePenalty", config.sameArtistInQueuePenalty, "artist is already represented in the rolling queue");
    if (album && queueAlbums.filter((value) => value === album).length >= config.maxSameAlbumInQueue) penalty("sameAlbumInQueuePenalty", config.sameAlbumRecentPenalty, "album is already represented in the rolling queue");

    if (sourceKind === "same_artist_top_tracks") penalty("sameSourcePathOverusePenalty", config.sameSourcePathOverusePenalty, "same-artist top tracks are a low-diversity expansion path");
    if (sourceKind === "same_album_other_tracks") penalty("sameAlbumOtherTracksPenalty", config.sameAlbumRecentPenalty, "same-album expansion is intentionally low frequency");
    if (recentSourcePaths.filter((path) => path.includes("artist_top_track") || path.includes("same_artist_top_tracks")).length >= 2 && sourceKind === "same_artist_top_tracks") {
      penalty("sameSourcePathOverusePenalty", config.sameSourcePathOverusePenalty, "same-artist source path was used too often recently");
    }

    const artistRecentFrequency = recent.slice(-20).filter((entry) => normalize(entry.artist) === artist).length / Math.max(1, Math.min(20, recent.length));
    const queueFrequency = queueArtists.filter((value) => value === artist).length / Math.max(1, queueArtists.length || 1);
    if (artist && Math.max(artistRecentFrequency, queueFrequency) > 0.25) penalty("artistOverfitPenalty", config.artistOverfitPenalty, "artist frequency is too high in recent playback or future queue");

    if (sourceKind === "similar_track_different_artist") bonus("similarTrackDifferentArtistBonus", config.similarTrackDifferentArtistBonus, "similar-track result points to a different artist");
    if (sourceKind === "random_exploration" || sourceKind === "similar_artist_representative") bonus("explorationBonus", config.explorationBonus, "candidate keeps the queue moving outward");
    if (artist && !recent.slice(-20).some((entry) => normalize(entry.artist) === artist)) bonus("newArtistBonus", config.newArtistBonus, "artist has not appeared recently");

    const nextScore = {
      ...entry.score,
      total: Number((entry.score.total + delta).toFixed(3)),
      explanation: delta
        ? `${entry.score.explanation} Diversity guard adjusted score by ${delta.toFixed(2)}.`
        : entry.score.explanation
    };
    return { ...entry, score: nextScore };
  }).sort((a, b) => b.score.total - a.score.total);

  const withExploration = ensureExplorationSlot({ candidates: adjusted, recentHistory: recent, config });
  const output = {
    candidates: withExploration,
    penaltiesApplied,
    bonusesApplied,
    explorationSlots: withExploration.slice(0, 3).filter((entry) => isExplorationCandidate(entry)).length
  };
  lastDiversityDebug = { ...output, beforeDiversityGuard: input.candidates.slice(0, 20), recentArtists, recentAlbums };
  return output;
}

export function ensureExplorationSlot(input: { candidates: RankedCandidate[]; recentHistory: RadioState["playHistory"]; config?: Partial<DiversityGuardConfig> }) {
  const config = { ...DIVERSITY_GUARD_CONFIG, ...(input.config ?? {}) };
  const top = input.candidates.slice(0, 3);
  if (top.some(isExplorationCandidate)) return input.candidates;
  const floor = Math.max(config.explorationScoreFloor, (input.candidates[0]?.score.total ?? 0) - 2.2);
  const index = input.candidates.findIndex((entry, idx) => idx >= 3 && isExplorationCandidate(entry) && entry.score.total >= floor);
  if (index < 0) return input.candidates;
  const copy = [...input.candidates];
  const [explorer] = copy.splice(index, 1);
  copy.splice(Math.min(2, copy.length), 0, {
    ...explorer,
    score: { ...explorer.score, total: Number((explorer.score.total + 0.08).toFixed(3)), explanation: `${explorer.score.explanation} Exploration slot promoted this candidate.` }
  });
  return copy;
}

export function classifyCandidateSourcePath(candidate: RankedCandidate["candidate"]): CandidateSourcePath {
  const paths = candidate.sourcePaths ?? [];
  if (paths.some((path) => path.includes("random_exploration") || path.includes("exploration") || path.includes("explore_neighbor"))) return "random_exploration";
  if (paths.some((path) => path.includes("album_track") || path.includes("same_album_other_tracks"))) return "same_album_other_tracks";
  if (paths.some((path) => path.includes("artist_top_track") || path.includes("same_artist_top_tracks"))) return "same_artist_top_tracks";
  if (paths.some((path) => path.includes("similar_artist") || path.includes("similar_artist_representative"))) return "similar_artist_representative";
  if (paths.some((path) => path.includes("similar_track"))) {
    return hasDifferentSeedArtist(candidate) ? "similar_track_different_artist" : "similar_track_same_artist";
  }
  if (paths.some((path) => path.includes("base_library") || path.includes("seed:base_library"))) return "base_library";
  return "random_exploration";
}

export function getLastDiversityDebug() {
  return lastDiversityDebug;
}

function isExplorationCandidate(entry: RankedCandidate) {
  const kind = classifyCandidateSourcePath(entry.candidate);
  return kind === "similar_track_different_artist" || kind === "similar_artist_representative" || kind === "random_exploration";
}

function hasDifferentSeedArtist(candidate: RankedCandidate["candidate"]) {
  const artist = normalize(candidate.playableTrack.artist);
  const refs = candidate.seedRefs ?? [];
  if (!artist || refs.length === 0) return true;
  return refs.some((seed) => seed.artist && normalize(seed.artist) !== artist);
}

function display(entry: RankedCandidate) {
  return `${entry.candidate.playableTrack.title} - ${entry.candidate.playableTrack.artist}`;
}

function normalize(value: string | undefined) {
  return (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizeAlbum(album: string | undefined, artist?: string) {
  const normalized = normalize(album);
  if (!normalized || normalized === "unknown album") return "";
  return `${normalized}::${normalize(artist)}`;
}
