import type { RadioNextResponse } from "../../../../lib/types";
import type { RecommendationSeed, SeedSource } from "../../../../lib/recommender/selectSeeds";

export type QueueSlotStatus =
  | "empty"
  | "seed_ready"
  | "candidate_pool_ready"
  | "track_ready"
  | "script_ready"
  | "tts_ready"
  | "playing"
  | "played"
  | "stale"
  | "failed";

export type RollingQueueSlot = {
  id: string;
  index: number;
  status: QueueSlotStatus;
  seeds?: RecommendationSeed[];
  item?: RadioNextResponse;
  sourceRunId?: string;
  locked: boolean;
  stale: boolean;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type WarmupPackage = {
  id: string;
  item: RadioNextResponse;
  sourceRunId: string;
  seedRefs: Array<{
    type: "track" | "artist" | "album";
    title?: string;
    artist?: string;
    album?: string;
    source: SeedSource | string;
    weight: number;
  }>;
  moodTags?: string[];
  timeOfDay?: "morning" | "afternoon" | "evening" | "night" | "any";
  createdAt: string;
  expiresAt: string;
  valid: boolean;
  invalidReason?: string;
};

export const ROLLING_QUEUE_TARGETS = {
  minTtsReady: 1,
  minScriptReady: 1,
  minTrackReady: 1,
  minSeedReady: 2,
  maxQueueLength: 5
};

export const WARMUP_CONFIG = {
  defaultTtlHours: 24,
  nightTtlHours: 12,
  invalidateOnNegativeFeedback: true
};

export type RollingQueueSnapshot = {
  sessionId: string;
  queue: RollingQueueSlot[];
  refillRunning: boolean;
  workers: Record<string, "idle" | "running" | "failed">;
  updatedAt: string;
};
