import { NextResponse } from "next/server";
import { loadImportedPlaylist } from "@/lib/playlist";
import { loadRadioState } from "@/lib/radioState";
import { buildTasteProfile } from "@/lib/taste";
import { listRecentSeedUsageEvents } from "@/lib/db";
import { selectSeeds } from "@/lib/recommender/selectSeeds";
import { generateDiscoveryPlan } from "@/lib/discovery";

export async function POST() {
  const [playlist, state] = await Promise.all([loadImportedPlaylist(), loadRadioState()]);
  const tasteProfile = buildTasteProfile(playlist);
  const seedUsageHistory = listRecentSeedUsageEvents(20);
  const seeds = selectSeeds({ playlist, state, limit: 5, recentSeedUsage: seedUsageHistory, seedMode: "base_random" });
  const calls: Array<{ method: string; params: Record<string, string> }> = [];
  const candidates = [];
  for (const seed of seeds.slice(0, 2)) {
    if (seed.type === "track") calls.push({ method: "track.getSimilar", params: { track: seed.title, artist: seed.artist } });
    if (seed.type === "artist") calls.push({ method: "artist.getSimilar", params: { artist: seed.artist } }, { method: "artist.getTopTracks", params: { artist: seed.artist } });
    if (seed.type === "album") calls.push({ method: "album.getInfo", params: { album: seed.album, artist: seed.artist } });
    const sourceSeed = seed.type === "track" ? { title: seed.title, artist: seed.artist, album: seed.album ?? "", duration: "" } : seed.type === "artist" ? { title: "", artist: seed.artist, album: "", duration: "" } : { title: "", artist: seed.artist, album: seed.album, duration: "" };
    const plan = await generateDiscoveryPlan({ sourceSeed, tasteProfile, recentTracks: state.recentTracks, recentSkippedTracks: state.skippedTracks, likedTracks: state.likedTracks, timeOfDay: "debug", mode: "similarSongs" });
    candidates.push(...plan.candidateSongs.slice(0, 5));
  }
  return NextResponse.json({ usedEntityBasedExpansion: true, usedLanguageGenreKeywordSearch: false, seedMode: "base_random", usedPreviousTrackAsPrimarySeed: false, seeds, seedUsageHistory, lastfmCalls: calls, candidates });
}

