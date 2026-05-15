import { prepareHourlyChime } from "@/lib/hourlyChime";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const targetHourIso = url.searchParams.get("targetHour") ?? undefined;
  const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
  const result = await prepareHourlyChime({ targetHourIso, force });
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { targetHourIso?: string; targetHour?: string; force?: boolean };
  const result = await prepareHourlyChime({ targetHourIso: body.targetHourIso ?? body.targetHour, force: body.force });
  return NextResponse.json(result);
}
