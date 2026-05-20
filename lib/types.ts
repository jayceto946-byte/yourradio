export type Song = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  audioUrl: string;
  platform: string;
  coverUrl?: string;
  lyricId?: string;
  sourceUrl?: string;
};

export type PlaylistSong = {
  title: string;
  artist: string;
  album: string;
  duration: string;
};

export type MusicProviderName = "netease" | "spotify" | "apple" | string;

export type MusicSearchQuery = {
  keyword: string;
  limit?: number;
  provider?: MusicProviderName;
};

export type MusicSearchResult = {
  query: MusicSearchQuery;
  songs: Song[];
  providerTried?: string[];
};

export type RecommendationFailure = {
  ok: false;
  code: "NO_SEEDS" | "LASTFM_NO_RESULTS" | "NO_PLAYABLE_CANDIDATES" | "RANKER_EMPTY" | "PROVIDER_ERROR";
  message: string;
  debug?: unknown;
};
export type DjScript = {
  text: string;
  mood: string;
  source?: "llm" | "fallback";
  style?: string;
  error?: string;
  debug?: DjContextDebug;
};

export type TtsResult = {
  provider: "none";
  language: string;
  voiceName?: string;
};

export type RadioTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  coverUrl: string;
  audioUrl: string;
};

export type SearchStrategy = "exact" | "tasteExpansion" | "adjacentExpansion" | "discovery" | "exploration" | "requested";

export type SourceSeed = {
  title: string;
  artist: string;
  album: string;
};

export type CandidateDebug = {
  title: string;
  artist: string;
  provider: string;
  score: number;
  rejectedReasons: string[];
};

export type DiscoveryDebug = {
  source: "lastfm" | "llm" | "chosic" | "manual" | "cache";
  searchIntent: string;
  queriesUsed: string[];
  candidateSongs: Array<{
    title: string;
    artist: string;
    source: string;
    confidence: string;
  }>;
};

export type DjContextDebug = {
  tone?: string;
  usedContext: string[];
  confidence: "high" | "medium" | "low";
  timeOfDay: string;
  recentTracks: string[];
  tasteLoaded: boolean;
  source?: "llm" | "fallback";
  style?: string;
  error?: string;
};

export type RadioNextResponse = {
  track: RadioTrack;
  djLine: string;
  ttsUrl: string | null;
  ttsSkipped?: boolean;
  searchQuery: string;
  searchStrategy?: SearchStrategy;
  tasteKeywordsUsed?: string[];
  sourceSeed: SourceSeed;
  reason: string;
  fallbackUsed: boolean;
  liveFilteredCount?: number;
  livePenaltyApplied?: boolean;
  providerTried?: string[];
  selectedProvider?: string;
  candidateDebug?: CandidateDebug[];
  fallbackReason?: string | null;
  djContextDebug?: DjContextDebug;
  discovery?: DiscoveryDebug;
  rankerSourcePaths?: string[];
  rankerScore?: number;
};

export type FeedbackAction = "like" | "like_style" | "skip" | "neutral-next";

export type StyleSeedCandidate = {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  tags?: string[];
  sourcePaths?: string[];
  weight: number;
  createdAt: string;
  updatedAt: string;
  reason: "like_style" | "high_completion" | "replay";
};

export type RadioState = {
  recentTracks: string[];
  skippedTracks: string[];
  likedTracks: string[];
  artistWeights: Record<string, number>;
  keywordWeights: Record<string, number>;
  tagWeights?: Record<string, number>;
  albumWeights?: Record<string, number>;
  sourcePathWeights?: Record<string, number>;
  sourcePathTrust?: Record<string, number>;
  styleSeedCandidates?: StyleSeedCandidate[];
  tasteProfileDirty?: boolean;
  lastFeedbackEvents?: Array<{ action: FeedbackAction; trackId: string; title: string; artist: string; createdAt: string }>;
  shortTerm?: {
    artistWeights: Record<string, number>;
    tagWeights: Record<string, number>;
    skippedArtists: Record<string, number>;
    skippedTags: Record<string, number>;
  };
  adaptive?: {
    exploration: number;
    weights: Record<string, number>;
  };
  recentDjLines: string[];
  searchStrategyHistory?: SearchStrategy[];
  playHistory: Array<{
    id: string;
    title: string;
    artist: string;
    album: string;
    searchQuery: string;
    sourceSeed: SourceSeed;
    playedAt: string;
    tags?: string[];
    sourcePaths?: string[];
  }>;
};



