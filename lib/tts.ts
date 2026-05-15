import type { DjScript } from "./types";
import { measureRuntimeStep, recordRuntimeEvent } from "./runtimeLog";
import type { TtsGenerateOutput } from "../src/lib/tts/TtsProvider";
import { QWEN3_TTS_CONFIG, Qwen3CustomVoiceTtsProvider } from "../src/lib/tts/Qwen3CustomVoiceTtsProvider";
import { HTTP_TTS_CONFIG, HttpCompatibleTtsProvider } from "../src/lib/tts/HttpCompatibleTtsProvider";

export type PreparedTtsResult = {
  ok: boolean;
  provider: "qwen3_custom_voice" | "http_compatible" | "none";
  audioUrl?: string;
  audioPath?: string;
  cached?: boolean;
  latencyMs?: number;
  language: string;
  voiceName?: string;
  fallbackProvider?: "none";
  error?: string;
};

let lastTtsDebug: PreparedTtsResult | null = null;

export async function prepareDjTts(script: DjScript, options: { timeoutMs?: number; budgetMs?: number; priority?: "normal" | "low" } = {}): Promise<PreparedTtsResult> {
  const provider = process.env.TTS_PROVIDER || "qwen3_custom_voice";

  return measureRuntimeStep("tts.prepare", {
    provider,
    textLength: script.text.length,
    timeoutMs: options.timeoutMs,
    budgetMs: options.budgetMs,
    priority: options.priority ?? "normal"
  }, async () => {
    if (provider === "qwen3_custom_voice") {
      return prepareProviderResult(
        "qwen3_custom_voice",
        QWEN3_TTS_CONFIG.language,
        await new Qwen3CustomVoiceTtsProvider().generate({ text: script.text, language: QWEN3_TTS_CONFIG.language, timeoutMs: options.timeoutMs, budgetMs: options.budgetMs, priority: options.priority })
      );
    }

    if (provider === "http_compatible") {
      return prepareProviderResult(
        "http_compatible",
        HTTP_TTS_CONFIG.language,
        await new HttpCompatibleTtsProvider().generate({ text: script.text, language: HTTP_TTS_CONFIG.language, timeoutMs: options.timeoutMs, budgetMs: options.budgetMs, priority: options.priority })
      );
    }

    if (provider === "none") {
      return remember({ ok: false, provider: "none", language: "zh-CN", fallbackProvider: "none", error: "tts_disabled" });
    }

    return remember({
      ok: false,
      provider: "none",
      language: "zh-CN",
      fallbackProvider: "none",
      error: `unsupported_tts_provider:${provider}`
    });
  });
}

function prepareProviderResult(provider: "qwen3_custom_voice" | "http_compatible", language: string, output: TtsGenerateOutput): PreparedTtsResult {
  if (output.ok && output.audioUrl) {
    void recordRuntimeEvent({
      step: "tts.provider",
      status: "success",
      durationMs: output.latencyMs,
      context: { provider, cached: output.cached, audioUrl: output.audioUrl }
    });
    return remember({
      ok: true,
      provider,
      language,
      audioUrl: output.audioUrl,
      audioPath: output.audioPath,
      cached: output.cached,
      latencyMs: output.latencyMs
    });
  }

  void recordRuntimeEvent({
    step: "tts.provider",
    status: "error",
    durationMs: output.latencyMs,
    error: `${provider}:${output.error ?? "tts_failed"}`,
    context: { provider, fallback: "none" }
  });

  return remember({
    ok: false,
    provider: "none",
    language: "zh-CN",
    fallbackProvider: "none",
    latencyMs: output.latencyMs,
    error: `${provider}:${output.error ?? "tts_failed"}`
  });
}

export function getLastTtsDebug() {
  return lastTtsDebug;
}

function remember(result: PreparedTtsResult) {
  lastTtsDebug = result;
  return result;
}

export function isQwenTtsWithinBudget(output: TtsGenerateOutput, budgetMs = Number(process.env.TTS_PRELOAD_BUDGET_MS ?? 300000)) {
  return output.ok && output.latencyMs <= budgetMs;
}
