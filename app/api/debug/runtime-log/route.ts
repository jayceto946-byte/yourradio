import { NextResponse } from "next/server";
import { readRecentRuntimeEvents, recordRuntimeEvent, type RuntimeLogStatus } from "@/lib/runtimeLog";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") ?? 100);
  const events = await readRecentRuntimeEvents(limit);
  return NextResponse.json({ ok: true, events });
}
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    step?: string;
    status?: RuntimeLogStatus;
    durationMs?: number;
    message?: string;
    error?: string;
    context?: Record<string, unknown>;
  };
  const status = body.status === "started" || body.status === "success" || body.status === "error" || body.status === "info"
    ? body.status
    : "info";
  await recordRuntimeEvent({
    step: body.step || "client.runtime",
    status,
    durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
    message: typeof body.message === "string" ? body.message : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
    context: body.context && typeof body.context === "object" ? body.context : undefined
  });
  return NextResponse.json({ ok: true });
}

