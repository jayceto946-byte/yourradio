import { fetchWithTimeout } from "../../../lib/fetchWithTimeout";
import { recordRuntimeEvent } from "../../../lib/runtimeLog";
import type { TtsGenerateInput, TtsGenerateOutput, TtsProvider } from "./TtsProvider";
import { enqueueQwenTts } from "./ttsQueue";

export const QWEN3_TTS_CONFIG = {
  baseUrl: normalizeBaseUrl(process.env.QWEN3_TTS_BASE_URL || "http://127.0.0.1:8010"),
  model: process.env.QWEN3_TTS_MODEL || "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  device: process.env.QWEN3_TTS_DEVICE || "cuda",
  dtype: process.env.QWEN3_TTS_DTYPE || "float32",
  speaker: process.env.QWEN3_TTS_SPEAKER || "Serena",
  language: process.env.QWEN3_TTS_LANGUAGE || "Chinese",
  instruct: process.env.QWEN3_TTS_INSTRUCT || "\u66f4\u50cf\u6df1\u591c\u7535\u53f0\u4e3b\u6301\u4eba\uff0c\u58f0\u97f3\u653e\u677e\u3001\u8d34\u8fd1\u9ea6\u514b\u98ce\uff0c\u8bed\u901f\u6162\uff0c\u60c5\u7eea\u7a33\u5b9a\uff0c\u58f0\u97f3\u6175\u61d2\uff0c\u4e0d\u8981\u5938\u5f20\u3002",
  timeoutMs: Number(process.env.QWEN3_TTS_TIMEOUT_MS ?? 300000),
  preloadBudgetMs: Number(process.env.TTS_PRELOAD_BUDGET_MS ?? 300000)
};


type Qwen3TtsResponse = {
  ok?: boolean;
  cached?: boolean;
  provider?: string;
  model?: string;
  device?: string;
  dtype?: string;
  speaker?: string;
  language?: string;
  latencyMs?: number;
  audioPath?: string;
  audioUrl?: string;
  error?: string;
};

export class Qwen3CustomVoiceTtsProvider implements TtsProvider {
  readonly name = "qwen3_custom_voice";

  async generate(input: TtsGenerateInput): Promise<TtsGenerateOutput> {
    const startedAt = performance.now();
    const language = input.language || QWEN3_TTS_CONFIG.language;
    const timeoutMs = input.timeoutMs ?? QWEN3_TTS_CONFIG.timeoutMs;
    const budgetMs = input.budgetMs ?? QWEN3_TTS_CONFIG.preloadBudgetMs;
    const ttsText = normalizeTextForQwenTts(input.text);

    try {
      return await enqueueQwenTts(async () => {
        void recordRuntimeEvent({
          step: "tts.qwen3.request",
          status: "started",
          context: {
            baseUrl: QWEN3_TTS_CONFIG.baseUrl,
            speaker: QWEN3_TTS_CONFIG.speaker,
            textLength: ttsText.length,
            timeoutMs,
            budgetMs,
            priority: input.priority ?? "normal"
          }
        });

        const response = await fetchWithTimeout(`${QWEN3_TTS_CONFIG.baseUrl}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            text: ttsText,
            speaker: QWEN3_TTS_CONFIG.speaker,
            language,
            instruct: QWEN3_TTS_CONFIG.instruct
          }),
          cache: "no-store"
        }, timeoutMs);

        const rawText = await response.text();
        let data: Qwen3TtsResponse | null = null;
        try {
          data = rawText ? JSON.parse(rawText) as Qwen3TtsResponse : null;
        } catch {
          data = null;
        }

        if (!response.ok) {
          return fail(`http_${response.status}:${data?.error ?? rawText.slice(0, 160)}`, startedAt);
        }

        if (!data?.ok || !data.audioUrl) {
          return fail(data?.error ?? "qwen3_tts_failed", startedAt, data?.latencyMs);
        }

        void recordRuntimeEvent({
          step: "tts.qwen3.request",
          status: "success",
          durationMs: data.latencyMs ?? Math.round(performance.now() - startedAt),
          context: { cached: Boolean(data.cached), audioUrl: data.audioUrl }
        });

        return {
          ok: true,
          provider: this.name,
          audioUrl: absolutizeAudioUrl(data.audioUrl),
          audioPath: data.audioPath,
          format: "wav" as const,
          cached: Boolean(data.cached),
          latencyMs: data.latencyMs ?? Math.round(performance.now() - startedAt)
        };
      }, budgetMs, input.priority ?? "normal");
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : "qwen3_tts_error", startedAt);
    }
  }

  async healthCheck() {
    return checkQwen3TtsServiceReachable();
  }
}

export async function checkQwen3TtsServiceReachable() {
  const startedAt = performance.now();
  try {
    const response = await fetchWithTimeout(`${QWEN3_TTS_CONFIG.baseUrl}/health`, { cache: "no-store" }, 5000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      ok: response.ok && data.ok !== false,
      latencyMs: Math.round(performance.now() - startedAt),
      baseUrl: QWEN3_TTS_CONFIG.baseUrl,
      provider: "qwen3_custom_voice",
      model: String(data.model ?? QWEN3_TTS_CONFIG.model),
      device: String(data.device ?? QWEN3_TTS_CONFIG.device),
      dtype: String(data.dtype ?? QWEN3_TTS_CONFIG.dtype),
      speaker: String(data.speaker ?? QWEN3_TTS_CONFIG.speaker),
      loaded: Boolean(data.loaded),
      message: response.ok ? "Qwen3 TTS service is reachable." : "Qwen3 TTS service returned an error."
    };
  } catch (cause) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      baseUrl: QWEN3_TTS_CONFIG.baseUrl,
      provider: "qwen3_custom_voice",
      model: QWEN3_TTS_CONFIG.model,
      device: QWEN3_TTS_CONFIG.device,
      dtype: QWEN3_TTS_CONFIG.dtype,
      speaker: QWEN3_TTS_CONFIG.speaker,
      message: "Qwen3 TTS service is not reachable. Start it with python -m uvicorn qwen3_tts_server:app --host 127.0.0.1 --port 8010.",
      error: cause instanceof Error ? cause.message : "qwen3_health_error"
    };
  }
}

export async function fetchQwen3Speakers() {
  const startedAt = performance.now();
  try {
    const response = await fetchWithTimeout(`${QWEN3_TTS_CONFIG.baseUrl}/speakers`, { cache: "no-store" }, 30000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const speakers = Array.isArray(data.speakers) ? data.speakers.map(String) : [];
    return {
      ok: response.ok && data.ok !== false,
      speakers,
      selectedSpeaker: QWEN3_TTS_CONFIG.speaker,
      warning: speakers.length && !speakers.includes(QWEN3_TTS_CONFIG.speaker)
        ? `Configured speaker '${QWEN3_TTS_CONFIG.speaker}' was not returned by /speakers.`
        : undefined,
      latencyMs: Math.round(performance.now() - startedAt),
      error: typeof data.error === "string" ? data.error : undefined
    };
  } catch (cause) {
    return {
      ok: false,
      speakers: [],
      selectedSpeaker: QWEN3_TTS_CONFIG.speaker,
      latencyMs: Math.round(performance.now() - startedAt),
      error: cause instanceof Error ? cause.message : "qwen3_speakers_error"
    };
  }
}

function fail(error: string, startedAt: number, latencyMs?: number): TtsGenerateOutput {
  void recordRuntimeEvent({
    step: "tts.qwen3.request",
    status: "error",
    durationMs: latencyMs ?? Math.round(performance.now() - startedAt),
    error
  });
  return {
    ok: false,
    provider: "qwen3_custom_voice",
    cached: false,
    latencyMs: latencyMs ?? Math.round(performance.now() - startedAt),
    error
  };
}

export function normalizeTextForQwenTts(text: string) {
  return text
    .replace(/\\b[A-Z]{2,}\\b/g, (word) => word.toLowerCase())
    .replace(/\\s+/g, " ")
    .trim();
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function absolutizeAudioUrl(audioUrl: string) {
  if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
  return `${QWEN3_TTS_CONFIG.baseUrl}${audioUrl.startsWith("/") ? "" : "/"}${audioUrl}`;
}







