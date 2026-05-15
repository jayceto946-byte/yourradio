import { listRecentSeedUsageEvents } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
  const seedUsageHistory = listRecentSeedUsageEvents(limit);
  return NextResponse.json({ ok: true, seedUsageHistory });
}
