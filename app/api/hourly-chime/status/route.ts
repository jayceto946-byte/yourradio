import { getHourlyChimeStatus } from "@/lib/hourlyChime";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const targetHourIso = url.searchParams.get("targetHour") ?? undefined;
  const status = await getHourlyChimeStatus(targetHourIso);
  return NextResponse.json(status);
}
