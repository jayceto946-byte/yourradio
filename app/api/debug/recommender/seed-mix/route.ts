import { loadImportedPlaylist } from "@/lib/playlist";
import { loadRadioState } from "@/lib/radioState";
import { listRecentSeedUsageEvents } from "@/lib/db";
import { selectSeeds, SEED_SAMPLING_CONFIG, SEED_SAMPLING_MIX } from "@/lib/recommender/selectSeeds";
import { NextResponse } from "next/server";

export async function GET() {
  const [playlist, state] = await Promise.all([loadImportedPlaylist(), loadRadioState()]);
  const recentSeedUsage = listRecentSeedUsageEvents(20);
  const selectedSeeds = selectSeeds({ playlist, state, limit: SEED_SAMPLING_CONFIG.seedCountPerRun, recentSeedUsage, seedMode: "base_random" });
  return NextResponse.json({ ok: true, seedMix: SEED_SAMPLING_MIX, selectedSeeds });
}
