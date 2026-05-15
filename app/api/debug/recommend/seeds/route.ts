import { NextResponse } from "next/server";
import { loadImportedPlaylist } from "@/lib/playlist";
import { loadRadioState } from "@/lib/radioState";
import { listRecentSeedUsageEvents } from "@/lib/db";
import { selectSeeds } from "@/lib/recommender/selectSeeds";

export async function POST() {
  const [playlist, state] = await Promise.all([loadImportedPlaylist(), loadRadioState()]);
  return NextResponse.json({
    seedMode: "base_random",
    usedPreviousTrackAsPrimarySeed: false,
    seeds: selectSeeds({ playlist, state, limit: 12, recentSeedUsage: listRecentSeedUsageEvents(20), seedMode: "base_random" }),
    removedFields: ["language", "genreSearchQuery", "styleSearchQuery", "moodSearchQuery", "sceneSearchQuery", "freeTextMusicQuery"]
  });
}

