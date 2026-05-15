import { NextResponse } from "next/server";
import { getArtistTopTracks, getSimilarArtistTopTracks } from "@/lib/discovery/lastfmProvider";
export async function POST(request: Request) {
  const body = await request.json() as { artist?: string };
  if (!body.artist) return NextResponse.json({ error: "missing artist" }, { status: 400 });
  const similarArtistTracks = await getSimilarArtistTopTracks(body.artist);
  const seedArtistTopTracks = await getArtistTopTracks(body.artist, "seed artist top track");
  return NextResponse.json({ usedLanguageGenreKeywordSearch: false, methods: ["artist.getSimilar", "artist.getTopTracks"], candidates: [...similarArtistTracks, ...seedArtistTopTracks] });
}
