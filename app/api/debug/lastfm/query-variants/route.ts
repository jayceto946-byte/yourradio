import { NextResponse } from "next/server";
import { buildLastfmQueryVariants } from "@/lib/musicText/chineseVariants";

type Body = { title?: string; artist?: string; artistAliases?: string[] };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    if (!body.title || !body.artist) return NextResponse.json({ ok: false, error: "missing title or artist" }, { status: 400 });
    const variants = await buildLastfmQueryVariants({ title: body.title, artist: body.artist, artistAliases: body.artistAliases });
    return NextResponse.json({ ok: true, variants });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "query variants failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
