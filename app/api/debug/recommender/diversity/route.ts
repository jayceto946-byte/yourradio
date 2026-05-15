import { getLastDiversityDebug } from "@/lib/recommender/diversityGuard";
import { loadRadioState } from "@/lib/radioState";
import { loadRollingQueueSnapshot } from "@/src/lib/player/rollingQueue/rollingQueueStore";
import { NextResponse } from "next/server";

export async function GET() {
  const state = await loadRadioState();
  const snapshot = await loadRollingQueueSnapshot();
  const debug = getLastDiversityDebug();
  const recentArtists = state.playHistory.slice(-5).map((entry) => entry.artist).filter(Boolean);
  const recentAlbums = state.playHistory.slice(-10).map((entry) => entry.album).filter(Boolean);
  return NextResponse.json({
    ok: true,
    recentArtists,
    recentAlbums,
    queueArtists: snapshot.queue.map((slot) => slot.item?.track.artist).filter(Boolean),
    penaltiesApplied: debug?.penaltiesApplied ?? [],
    bonusesApplied: debug?.bonusesApplied ?? [],
    explorationSlots: debug?.explorationSlots ?? 0
  });
}
