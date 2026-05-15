import { NextResponse } from "next/server";
import { getSimilarTracksWithVariants } from "@/lib/discovery/lastfmProvider";
export async function POST(request: Request) {
  const body = await request.json() as { title?: string; artist?: string };
  if (!body.title || !body.artist) return NextResponse.json({ error: "missing title or artist" }, { status: 400 });
  const result = await getSimilarTracksWithVariants(body.title, body.artist);
  return NextResponse.json({ usedLanguageGenreKeywordSearch: false, method: "track.getSimilar", ...result });
}
