import { getTrackCard } from "@/src/lib/knowledge/knowledgeStore";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const title = url.searchParams.get("title") ?? "";
  const artist = url.searchParams.get("artist") ?? "";
  if (!title || !artist) return NextResponse.json({ ok: false, message: "title and artist are required" }, { status: 400 });
  return NextResponse.json({ ok: true, card: await getTrackCard(title, artist) });
}