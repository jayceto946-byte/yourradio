import { QWEN3_TTS_CONFIG, Qwen3CustomVoiceTtsProvider } from "@/src/lib/tts/Qwen3CustomVoiceTtsProvider";
import { isQwenTtsWithinBudget } from "@/lib/tts";
import { NextResponse } from "next/server";

const DEFAULT_TEXT = "这里是 YourRadio。接下来这首不用说得太满，它的声音更像夜里慢慢亮起的一盏灯，节奏不急，留白也够，适合让注意力从上一段旋律里自然落下来。";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text ?? DEFAULT_TEXT);
  const output = await new Qwen3CustomVoiceTtsProvider().generate({ text, language: QWEN3_TTS_CONFIG.language });

  return NextResponse.json({
    ...output,
    provider: "qwen3_custom_voice",
    model: QWEN3_TTS_CONFIG.model,
    device: QWEN3_TTS_CONFIG.device,
    dtype: QWEN3_TTS_CONFIG.dtype,
    speaker: QWEN3_TTS_CONFIG.speaker,
    language: QWEN3_TTS_CONFIG.language,
    within90s: isQwenTtsWithinBudget(output, 90000),
    within120s: isQwenTtsWithinBudget(output, Number(body.timeoutMs ?? 120000))
  });
}


