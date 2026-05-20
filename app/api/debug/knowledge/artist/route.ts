import { getArtistCard } from "@/src/lib/knowledge/knowledgeStore";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const artist = url.searchParams.get("artist") ?? "";
  if (!artist) return NextResponse.json({ ok: false, message: "artist is required" }, { status: 400 });
  return NextResponse.json({ ok: true, card: await getArtistCard(artist) });
}