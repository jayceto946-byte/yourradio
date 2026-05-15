import { formatTrackForSpeech } from "@/src/lib/dj/formatTrackForSpeech";
import { searchWikiSongInfo } from "@/src/lib/dj/WikiSongInfoProvider";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const rawTitle = String(body.title ?? body.rawTitle ?? "");
  const rawArtist = String(body.artist ?? body.rawArtist ?? "");
  const album = body.album ? String(body.album) : undefined;
  const formatted = formatTrackForSpeech({ title: rawTitle, artist: rawArtist, album });
  const result = await searchWikiSongInfo({
    rawTitle,
    speechTitle: formatted.speechTitle,
    rawArtist,
    displayArtist: formatted.displayArtist,
    album,
    isSoundtrackLike: formatted.isSoundtrackLike,
    featuredArtists: formatted.featuredArtists,
    timeoutMs: body.timeoutMs ? Number(body.timeoutMs) : undefined
  });

  return NextResponse.json({
    ok: result.ok,
    queries: result.searchedQueries,
    facts: result.facts,
    usedEndpoints: result.usedEndpoints,
    latencyMs: result.latencyMs,
    errors: result.error ? [result.error] : []
  });
}
