import { getAlbumCard } from "@/src/lib/knowledge/knowledgeStore";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const artist = url.searchParams.get("artist") ?? "";
  const album = url.searchParams.get("album") ?? "";
  if (!artist || !album) return NextResponse.json({ ok: false, message: "artist and album are required" }, { status: 400 });
  return NextResponse.json({ ok: true, card: await getAlbumCard(artist, album) });
}