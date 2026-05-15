import { listTtsCache } from "@/src/lib/tts/ttsCache";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    provider: "qwen3_custom_voice",
    items: listTtsCache(100)
  });
}
