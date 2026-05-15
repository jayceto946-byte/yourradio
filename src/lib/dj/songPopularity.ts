export type SongPopularityInput = {
  lastfmListeners?: number;
  lastfmPlaycount?: number;
  artistTopTrackRank?: number;
  localPlayCount?: number;
  localCompletionRate?: number;
  hasLastfmWiki?: boolean;
};

export function computePopularityScore(input: SongPopularityInput): number {
  const localPopularity = Math.min(1, ((input.localPlayCount ?? 0) / 10) * 0.65 + (input.localCompletionRate ?? 0) * 0.35);
  const metadataRichness = input.hasLastfmWiki ? 1 : 0;
  return clamp01(
    0.3 * logNorm(input.lastfmListeners ?? 0) +
    0.25 * logNorm(input.lastfmPlaycount ?? 0) +
    0.2 * rankScore(input.artistTopTrackRank) +
    0.2 * localPopularity +
    0.05 * metadataRichness
  );
}

function logNorm(value: number, maxLog = 7) {
  return Math.min(1, Math.log10(Math.max(0, value) + 1) / maxLog);
}

function rankScore(rank?: number) {
  if (!rank) return 0;
  return Math.max(0, 1 - (rank - 1) / 50);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
