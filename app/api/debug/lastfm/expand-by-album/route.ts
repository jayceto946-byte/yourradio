import { NextResponse } from "next/server";
import { getAlbumTracks } from "@/lib/discovery/lastfmProvider";
export async function POST(request: Request) {
  const body = await request.json() as { album?: string; artist?: string };
  if (!body.album || !body.artist) return NextResponse.json({ error: "missing album or artist" }, { status: 400 });
  const candidates = await getAlbumTracks(body.album, body.artist);
  return NextResponse.json({ usedLanguageGenreKeywordSearch: false, method: "album.getInfo", candidates });
}
