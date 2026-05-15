import { checkQwen3TtsServiceReachable, fetchQwen3Speakers, QWEN3_TTS_CONFIG } from "@/src/lib/tts/Qwen3CustomVoiceTtsProvider";
import { NextResponse } from "next/server";

export async function GET() {
  const [health, speakers] = await Promise.all([
    checkQwen3TtsServiceReachable(),
    fetchQwen3Speakers()
  ]);

  return NextResponse.json({
    ...health,
    baseUrl: QWEN3_TTS_CONFIG.baseUrl,
    provider: "qwen3_custom_voice",
    model: QWEN3_TTS_CONFIG.model,
    device: QWEN3_TTS_CONFIG.device,
    dtype: QWEN3_TTS_CONFIG.dtype,
    speaker: QWEN3_TTS_CONFIG.speaker,
    speakers: speakers.speakers,
    speakersWarning: speakers.warning,
    startCommand: "cd C:\\path\\to\\YourRadio\\tools\\qwen3-tts-server && uvicorn qwen3_tts_server:app --host 127.0.0.1 --port 8010"
  });
}
