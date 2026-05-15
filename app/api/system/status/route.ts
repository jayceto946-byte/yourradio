import { NextResponse } from "next/server";

export const runtime = "nodejs";

type TtsHealth = {
  ok: boolean;
  baseUrl: string;
  latencyMs?: number;
  loaded?: boolean;
  speaker?: string;
  model?: string;
  error?: string;
};

const QWEN3_BASE_URL = (process.env.QWEN3_TTS_BASE_URL || "http://127.0.0.1:8010").replace(/\/+$/, "");

export async function GET() {
  const tts = await checkTtsHealth();
  return NextResponse.json({
    ok: true,
    server: {
      ok: true,
      name: "YourRadio",
      checkedAt: new Date().toISOString()
    },
    tts
  });
}

async function checkTtsHealth(): Promise<TtsHealth> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${QWEN3_BASE_URL}/health`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store"
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      return { ok: false, baseUrl: QWEN3_BASE_URL, latencyMs, error: `http_${response.status}` };
    }
    const data = await response.json().catch(() => ({}));
    return {
      ok: data?.ok !== false,
      baseUrl: QWEN3_BASE_URL,
      latencyMs,
      loaded: Boolean(data?.loaded),
      speaker: typeof data?.speaker === "string" ? data.speaker : undefined,
      model: typeof data?.model === "string" ? data.model : undefined,
      error: typeof data?.error === "string" ? data.error : undefined
    };
  } catch (cause) {
    return {
      ok: false,
      baseUrl: QWEN3_BASE_URL,
      latencyMs: Math.round(performance.now() - startedAt),
      error: cause instanceof Error ? cause.message : String(cause)
    };
  } finally {
    clearTimeout(timeout);
  }
}
