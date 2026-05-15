import { NextResponse } from "next/server";
import { loadRadioState } from "@/lib/radioState";
import { buildTasteProfile } from "@/lib/taste";
import { rankCandidates, type PlayableCandidate } from "@/lib/recommender/rankCandidates";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { candidate?: PlayableCandidate; context?: { exploration?: number } };
    if (!body.candidate) return NextResponse.json({ ok: false, error: "missing candidate" }, { status: 400 });
    const state = await loadRadioState();
    const tasteProfile = buildTasteProfile([]);
    const [ranked] = rankCandidates({
      candidates: [body.candidate],
      tasteProfile,
      radioState: state,
      exploration: body.context?.exploration ?? state.adaptive?.exploration ?? 0.35
    });
    return NextResponse.json({ ok: true, score: ranked?.score ?? null, explanation: ranked?.score.explanation ?? "candidate filtered out" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "explain candidate failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
