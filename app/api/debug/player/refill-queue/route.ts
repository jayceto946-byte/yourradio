import { refillRollingQueue } from "@/src/lib/player/rollingQueue/rollingQueueStore";
import { NextResponse } from "next/server";

export async function POST() {
  const snapshot = await refillRollingQueue({ allowTts: true, force: true });
  return NextResponse.json({ ok: true, snapshot });
}
