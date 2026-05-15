import { listRecentSeedUsageEvents } from "@/lib/db";
import { loadImportedPlaylist } from "@/lib/playlist";
import { loadRadioState } from "@/lib/radioState";
import { selectSeeds, SEED_SAMPLING_CONFIG } from "@/lib/recommender/selectSeeds";
import { NextResponse } from "next/server";

export async function POST() {
  const [playlist, state] = await Promise.all([loadImportedPlaylist(), loadRadioState()]);
  const seedUsageHistory = listRecentSeedUsageEvents(20);
  const seeds = selectSeeds({ playlist, state, limit: SEED_SAMPLING_CONFIG.seedCountPerRun, recentSeedUsage: seedUsageHistory, seedMode: "base_random" });

  return NextResponse.json({
    ok: true,
    seedMode: "base_random",
    usedPreviousTrackAsPrimarySeed: false,
    seeds,
    seedUsageHistory,
    constraints: {
      previous_track_max_seed_weight_share: SEED_SAMPLING_CONFIG.previousTrackMaxWeightShare,
      recentSeedHardAvoidRuns: SEED_SAMPLING_CONFIG.recentSeedHardAvoidRuns,
      recentSeedSoftAvoidRuns: SEED_SAMPLING_CONFIG.recentSeedSoftAvoidRuns
    }
  });
}
