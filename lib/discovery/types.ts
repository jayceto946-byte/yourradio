import type { PlaylistSong, Song } from "../types";
import type { TasteProfile } from "../taste";

export type DiscoverySource = "lastfm" | "llm" | "chosic" | "manual" | "cache";

export type DiscoveryConfidence = "high" | "medium" | "low";

export type DiscoveryCandidate = {
  title: string;
  artist: string;
  album?: string;
  reason?: string;
  source: DiscoverySource;
  confidence: DiscoveryConfidence;
  seed?: {
    title?: string;
    artist?: string;
    album?: string;
  };
  tags?: string[];
  sourcePaths?: string[];
  seedWeights?: number[];
  similarityScores?: number[];
  queryVariantWeights?: number[];
  queryVariantTypes?: string[];
  queryVariants?: Array<{ title: string; artist: string; variantType: string; weight: number }>;
  raw?: unknown;
};

export type DiscoveryPlan = {
  seed: {
    title?: string;
    artist?: string;
    album?: string;
  };
  searchIntent: string;
  similarSongQueries: string[];
  similarArtistQueries: string[];
  candidateSongs: DiscoveryCandidate[];
  avoidKeywords: string[];
  reason: string;
  source: DiscoverySource;
  error?: string;
};

export type GenerateDiscoveryPlanInput = {
  seedTrack?: Song;
  sourceSeed?: PlaylistSong;
  tasteProfile: TasteProfile;
  recentTracks: string[];
  recentSkippedTracks: string[];
  likedTracks: string[];
  timeOfDay: string;
  mode: "similarSongs" | "similarArtists" | "styleExpansion" | "exploration";
};

export type DiscoveryProvider = {
  name: DiscoverySource;
  enabled: boolean;
  findSimilarSongs(input: {
    title?: string;
    artist?: string;
    query?: string;
  }): Promise<DiscoveryCandidate[]>;
};

export type DiscoveryCacheItem = DiscoveryCandidate & {
  createdAt: string;
  lastTriedAt?: string;
  playableVerified: boolean;
  providerMatched: string | null;
  unavailableCount?: number;
};

export type DiscoveryCache = {
  items: DiscoveryCacheItem[];
};



