export type RecommenderWeights = {
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

export const DEFAULT_RECOMMENDER_WEIGHTS: RecommenderWeights = {
  lastfmSimilarity: 3.5,
  seedWeight: 2.5,
  tagOverlap: 2.0,
  sourcePathStrength: 1.8,
  artistAffinity: 1.5,
  playableMatchConfidence: 1.5,
  novelty: 1.0,
  explorationBonus: 0.8,
  multiSeedSupportBonus: 1.2,
  recentlyPlayedPenalty: 4.0,
  recentlySkippedPenalty: 6.0,
  sameArtistOverusePenalty: 2.0,
  overplayedTagPenalty: 2.5,
  lowConfidencePenalty: 3.0,
  seedDriftPenalty: 2.0,
  previousTrackOnlyPenalty: 3.0,
  versionPenalty: 4.0
};

export const SOURCE_PATH_WEIGHTS: Record<string, number> = {
  "similar_track_different_artist": 1.08,
  "lastfm:similar_track": 1.0,
  "similar_track_same_artist": 0.82,
  "similar_artist_representative": 0.78,
  "lastfm:similar_artist:top_track": 0.72,
  "same_artist_top_tracks": 0.34,
  "lastfm:artist_top_track": 0.34,
  "same_album_other_tracks": 0.28,
  "lastfm:album_track": 0.28,
  "fallback:lastfm:tag_top_track": 0.25,
  "base_library": 0.22,
  "random_exploration": 0.2,
  "fallback:custom_search": 0.1
};



