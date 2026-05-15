import { getLastTtsDebug } from "@/lib/tts";
import { listTtsCache } from "@/src/lib/tts/ttsCache";
import { getQwenTtsQueueStatus } from "@/src/lib/tts/ttsQueue";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return NextResponse.json({
    items: listTtsCache(limit),
    queue: getQwenTtsQueueStatus(),
    lastTts: getLastTtsDebug()
  });
}
