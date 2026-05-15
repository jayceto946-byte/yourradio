import { loadRadioState } from "@/lib/radioState";
import { NextResponse } from "next/server";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  const startedAt = performance.now();
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;

  try {
    const state = await loadRadioState();
    const history = [...state.playHistory].reverse();
    const items = history.slice(cursor, cursor + limit);
    const nextCursor = cursor + items.length < history.length ? cursor + items.length : null;

    return NextResponse.json({
      ok: true,
      items,
      nextCursor,
      totalKnown: history.length
    });
  } finally {
    if (process.env.NODE_ENV === "development") {
      console.log(`[perf] /api/history: ${Math.round(performance.now() - startedAt)}ms`);
    }
  }
}
