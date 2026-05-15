import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    status: "client_memory",
    selectedTrackReady: null,
    researchStatus: "client_memory",
    scriptSource: "client_memory",
    blockedByResearch: false,
    runId: null,
    forTrackId: null,
    willBeInterruptedByFeedback: false,
    note: "The current next-track buffer lives in the browser playback state. Research timeout now falls back to a script and does not clear selectedTrack. like_style only records future preference and does not cancel or clear the buffer."
  });
}
