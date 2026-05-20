import { QWEN3_TTS_CONFIG, Qwen3CustomVoiceTtsProvider } from "@/src/lib/tts/Qwen3CustomVoiceTtsProvider";
import { isQwenTtsWithinBudget } from "@/lib/tts";
import { NextResponse } from "next/server";

const DEFAULT_TEXT = "\u8fd9\u91cc\u662f YourRadio\u3002\u4e0b\u4e00\u9996\u5148\u628a\u80cc\u666f\u653e\u8f7b\u4e00\u70b9\uff0c\u5b83\u7684\u58f0\u97f3\u66f4\u50cf\u591c\u91cc\u6162\u6162\u4eae\u8d77\u7684\u4e00\u76cf\u706f\uff0c\u8282\u594f\u4e0d\u6025\uff0c\u7559\u767d\u4e5f\u591f\uff0c\u9002\u5408\u8ba9\u6ce8\u610f\u529b\u81ea\u7136\u843d\u4e0b\u6765\u3002";

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


