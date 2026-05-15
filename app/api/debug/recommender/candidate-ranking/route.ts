import { getLastDiversityDebug } from "@/lib/recommender/diversityGuard";
import { NextResponse } from "next/server";

export async function GET() {
  const debug = getLastDiversityDebug();
  return NextResponse.json({
    ok: true,
    beforeDiversityGuard: debug?.beforeDiversityGuard?.slice(0, 10).map((entry) => ({
      trackId: entry.score.trackId,
      title: entry.candidate.playableTrack.title,
      artist: entry.candidate.playableTrack.artist,
      album: entry.candidate.playableTrack.album,
      total: entry.score.total,
      sourcePaths: entry.candidate.sourcePaths
    })) ?? [],
    afterDiversityGuard: debug?.candidates?.slice(0, 10).map((entry) => ({
      trackId: entry.score.trackId,
      title: entry.candidate.playableTrack.title,
      artist: entry.candidate.playableTrack.artist,
      album: entry.candidate.playableTrack.album,
      total: entry.score.total,
      sourcePaths: entry.candidate.sourcePaths
    })) ?? [],
    removedOrDownranked: debug?.penaltiesApplied ?? [],
    bonusesApplied: debug?.bonusesApplied ?? [],
    explorationCandidateSelected: Boolean(debug?.candidates?.slice(0, 3).some((entry) => entry.score.explanation.includes("Exploration slot") || entry.candidate.sourcePaths.some((path) => path.includes("similar_track") || path.includes("exploration"))))
  });
}
