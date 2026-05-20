import { NextResponse } from "next/server";
import { resolveRequestedSong } from "@/lib/requestSong/resolveRequestedSong";
import { recordRuntimeEvent } from "@/lib/runtimeLog";
import { enqueueRequestedRadioItem } from "@/src/lib/player/rollingQueue/rollingQueueStore";

export async function POST(request: Request) {
  const startedAt = performance.now();
  let text = "";
  try {
    const body = await request.json().catch(() => ({}));
    text = String(body.text ?? "").trim();
    if (!text) {
      return NextResponse.json({ ok: false, message: "request text is required" }, { status: 400 });
    }

    const resolved = await resolveRequestedSong(text);
    const queued = await enqueueRequestedRadioItem({
      track: resolved.selected.song,
      requestText: text,
      providerTried: resolved.providerTried,
      selectedProvider: resolved.selected.provider,
      score: resolved.selected.score,
      keywords: resolved.keywords
    });

    void recordRuntimeEvent({
      step: "requestSong.api",
      status: "success",
      durationMs: Math.round(performance.now() - startedAt),
      context: {
        text,
        track: `${resolved.selected.song.title} - ${resolved.selected.song.artist}`,
        selectedProvider: resolved.selected.provider,
        score: resolved.selected.score
      }
    });

    return NextResponse.json({
      ok: true,
      parsed: {
        keyword: resolved.parsed.keyword,
        confidence: resolved.parsed.confidence
      },
      queued: true,
      track: queued.item.track,
      selectedProvider: resolved.selected.provider,
      score: resolved.selected.score,
      candidates: resolved.candidates.slice(0, 5).map((candidate) => ({
        title: candidate.song.title,
        artist: candidate.song.artist,
        album: candidate.song.album,
        provider: candidate.provider,
        score: candidate.score,
        rejectedReasons: candidate.rejectedReasons
      }))
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "request song failed";
    void recordRuntimeEvent({
      step: "requestSong.api",
      status: "error",
      durationMs: Math.round(performance.now() - startedAt),
      error: message,
      context: { text }
    });
    return NextResponse.json({ ok: false, message }, { status: 404 });
  }
}
