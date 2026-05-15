import { listRecentSeedUsageEvents } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const seedUsageHistory = listRecentSeedUsageEvents(20);
  const latestRunId = seedUsageHistory[0]?.run_id ?? null;
  const latestSeeds = latestRunId ? seedUsageHistory.filter((event) => event.run_id === latestRunId) : [];
  const candidateSeedSources = seedUsageHistory.reduce<Record<string, number>>((stats, event) => {
    stats[event.source] = (stats[event.source] ?? 0) + 1;
    return stats;
  }, {});

  return NextResponse.json({
    ok: true,
    seedMode: "base_random",
    usedPreviousTrackAsPrimarySeed: latestSeeds[0]?.source === "previous_track_context",
    seeds: latestSeeds,
    seedUsageHistory,
    candidateSeedSources
  });
}
