import { formatTrackForSpeech } from "@/src/lib/dj/formatTrackForSpeech";
import { researchSongFacts } from "@/src/lib/dj/songResearch";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const rawTitle = String(body.title ?? body.rawTitle ?? "");
  const rawArtist = String(body.artist ?? body.rawArtist ?? "");
  const album = body.album ? String(body.album) : undefined;
  const formatted = formatTrackForSpeech({ title: rawTitle, artist: rawArtist, album });
  const result = await researchSongFacts({
    rawTitle,
    speechTitle: formatted.speechTitle,
    rawArtist,
    displayArtist: formatted.displayArtist,
    album,
    localPlayCount: Number(body.localPlayCount ?? 0),
    lastfmListeners: Number(body.lastfmListeners ?? 0),
    lastfmPlaycount: Number(body.lastfmPlaycount ?? 0),
    artistTopTrackRank: body.artistTopTrackRank ? Number(body.artistTopTrackRank) : undefined,
    prepareTimeBudgetMs: body.prepareTimeBudgetMs ? Number(body.prepareTimeBudgetMs) : 9000,
    isSoundtrackLike: formatted.isSoundtrackLike,
    featuredArtists: formatted.featuredArtists,
    recommendationReason: body.recommendationReason ? String(body.recommendationReason) : undefined
  });
  return NextResponse.json(result);
}
