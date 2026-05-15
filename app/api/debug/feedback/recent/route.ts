import { loadRadioState } from "@/lib/radioState";
import { NextResponse } from "next/server";

export async function GET() {
  const state = await loadRadioState();
  return NextResponse.json({ ok: true, lastFeedbackEvents: state.lastFeedbackEvents ?? [], tasteProfileDirty: Boolean(state.tasteProfileDirty) });
}
