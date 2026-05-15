import { NextResponse } from "next/server";
import { loadRadioState, saveRadioState } from "@/lib/radioState";
import { RECENCY_WINDOWS } from "@/lib/recommender/recencyWindows";
import { updateExploration } from "@/lib/recommender/updateExploration";

type Body = {
  trackId?: string;
  eventType?: "play_end" | "skip" | "replay" | "like" | "dislike";
  playedMs?: number;
  durationMs?: number;
  candidateContext?: {
    sourcePaths?: string[];
    tags?: string[];
    artist?: string;
  };
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const state = await loadRadioState();
    state.sourcePathTrust ??= {};
    state.tagWeights ??= {};
    state.shortTerm ??= { artistWeights: {}, tagWeights: {}, skippedArtists: {}, skippedTags: {} };
    state.adaptive ??= { exploration: 0.35, weights: {} };
    const completionRate = body.durationMs ? (body.playedMs ?? 0) / body.durationMs : 0;
    const negative = body.eventType === "skip" || completionRate < RECENCY_WINDOWS.negativeCompletionRate;
    const positive = body.eventType === "like" || body.eventType === "replay" || completionRate >= RECENCY_WINDOWS.strongCompletionRate;

    for (const path of body.candidateContext?.sourcePaths ?? []) {
      state.sourcePathTrust[path] = clamp((state.sourcePathTrust[path] ?? 1) + (positive ? 0.03 : negative ? -0.05 : 0), 0.2, 1.2);
    }

    for (const tag of body.candidateContext?.tags ?? []) {
      const key = tag.toLowerCase().trim();
      state.tagWeights[key] = clamp((state.tagWeights[key] ?? 0) + (positive ? 0.03 : negative ? -0.05 : 0), -1.5, 1.5);
      if (negative) state.shortTerm.skippedTags[key] = (state.shortTerm.skippedTags[key] ?? 0) + 0.15;
    }

    if (body.candidateContext?.artist && negative) {
      const key = body.candidateContext.artist.toLowerCase().trim();
      state.shortTerm.skippedArtists[key] = (state.shortTerm.skippedArtists[key] ?? 0) + 0.2;
    }

    updateExploration({
      state,
      eventType: body.eventType ?? "skip",
      isNewTrack: true,
      completionRate
    });
    await saveRadioState(state);
    return NextResponse.json({ ok: true, updatedTasteProfile: state });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "update feedback failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
