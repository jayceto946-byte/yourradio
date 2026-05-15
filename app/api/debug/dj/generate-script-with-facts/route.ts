import { generateDjLine } from "@/lib/dj";
import type { Song } from "@/lib/types";
import type { SongFact } from "@/src/lib/dj/songFacts";
import { formatTrackForSpeech } from "@/src/lib/dj/formatTrackForSpeech";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title ?? "");
  const artist = String(body.artist ?? "");
  const album = String(body.album ?? "");
  const facts = Array.isArray(body.facts) ? body.facts as SongFact[] : [];
  const formatted = formatTrackForSpeech({ title, artist, album });
  const factSummary = facts.map((fact) => fact.text).join("；");
  const song: Song = {
    id: "debug",
    title,
    artist,
    album,
    durationSeconds: 0,
    audioUrl: "",
    platform: "debug"
  };
  const script = await generateDjLine(song, {
    reason: factSummary ? `调试提供的歌曲资料：${factSummary}` : "debug script generation",
    scene: "normal"
  });
  return NextResponse.json({
    formatted,
    facts,
    script: script.text,
    debug: script.debug
  });
}

