import { NextResponse } from "next/server";
import { getSimilarTracksWithVariants } from "@/lib/discovery/lastfmProvider";

type Body = { title?: string; artist?: string };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    if (!body.title || !body.artist) return NextResponse.json({ ok: false, error: "missing title or artist" }, { status: 400 });
    const result = await getSimilarTracksWithVariants(body.title, body.artist);
    return NextResponse.json({ ok: true, ...result });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "similar tracks with variants failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
