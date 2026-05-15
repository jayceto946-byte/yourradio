import { NextResponse } from "next/server";
import { loadRadioState } from "@/lib/radioState";
import { buildTasteProfile } from "@/lib/taste";
import { rankCandidates, type PlayableCandidate } from "@/lib/recommender/rankCandidates";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { candidates?: PlayableCandidate[]; context?: { exploration?: number } };
    const state = await loadRadioState();
    const tasteProfile = buildTasteProfile([]);
    const scores = rankCandidates({
      candidates: body.candidates ?? [],
      context: undefined,
      tasteProfile,
      radioState: state,
      exploration: body.context?.exploration ?? state.adaptive?.exploration ?? 0.35
    } as Parameters<typeof rankCandidates>[0]).map((entry) => entry.score);

    return NextResponse.json({ ok: true, scores });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "score candidates failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
