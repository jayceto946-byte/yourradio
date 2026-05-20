export type SongFact = {
  type:
    | "release_date"
    | "album"
    | "soundtrack"
    | "background"
    | "artist_context"
    | "news"
    | "review"
    | "metadata";
  text: string;
  sourceName?: string;
  sourceUrl?: string;
  confidence: number;
};

export type SongResearchResult = {
  trackTitle: string;
  artist: string;
  album?: string;
  facts: SongFact[];
  usedProviders: string[];
  searched: boolean;
  wikiSearched: boolean;
  lastfmSearched?: boolean;
  cached: boolean;
  latencyMs: number;
  popularityScore?: number;
  queries?: string[];
  wikiQueries?: string[];
  lastfmQueries?: string[];
  triggerReasons?: string[];
  errors: string[];
  researchStatus?: "skipped" | "running" | "success" | "fallback" | "timeout";
  isChineseTrackLikelyLowCoverage?: boolean;
};

