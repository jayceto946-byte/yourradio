import { formatTrackForSpeech } from "@/src/lib/dj/formatTrackForSpeech";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(formatTrackForSpeech({
    title: String(body.title ?? ""),
    artist: String(body.artist ?? ""),
    album: body.album ? String(body.album) : undefined
  }));
}
