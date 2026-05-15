import { fetchWithTimeout } from "../../../lib/fetchWithTimeout";
import { recordRuntimeEvent } from "../../../lib/runtimeLog";
import type { TtsGenerateInput, TtsGenerateOutput, TtsProvider } from "./TtsProvider";

export const HTTP_TTS_CONFIG = {
  apiUrl: process.env.TTS_API_URL?.trim() || "",
  apiKey: process.env.TTS_API_KEY?.trim(),
  model: process.env.TTS_MODEL?.trim(),
  voice: process.env.TTS_VOICE?.trim(),
  language: process.env.TTS_LANGUAGE?.trim() || "zh-CN",
  timeoutMs: Number(process.env.TTS_TIMEOUT_MS ?? 120000)
};

type HttpCompatibleTtsResponse = {
  ok?: boolean;
  provider?: string;
  audioUrl?: string;
  audioPath?: string;
  format?: "wav" | "mp3";
  cached?: boolean;
  latencyMs?: number;
  error?: string;
};

export class HttpCompatibleTtsProvider implements TtsProvider {
  readonly name = "http_compatible";

  async generate(input: TtsGenerateInput): Promise<TtsGenerateOutput> {
    const startedAt = performance.now();
    if (!HTTP_TTS_CONFIG.apiUrl) {
      return fail("missing_tts_api_url", startedAt);
    }

    try {
      void recordRuntimeEvent({
        step: "tts.http.request",
        status: "started",
        context: {
          apiUrl: HTTP_TTS_CONFIG.apiUrl,
          model: HTTP_TTS_CONFIG.model,
          voice: HTTP_TTS_CONFIG.voice,
          textLength: input.text.length
        }
      });

      const headers: HeadersInit = {
        "Content-Type": "application/json",
        Accept: "application/json"
      };
      if (HTTP_TTS_CONFIG.apiKey) {
        headers.Authorization = `Bearer ${HTTP_TTS_CONFIG.apiKey}`;
      }

      const response = await fetchWithTimeout(HTTP_TTS_CONFIG.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: input.text,
          model: HTTP_TTS_CONFIG.model,
          voice: HTTP_TTS_CONFIG.voice,
          language: input.language || HTTP_TTS_CONFIG.language
        }),
        cache: "no-store"
      }, input.timeoutMs ?? HTTP_TTS_CONFIG.timeoutMs);

      const rawText = await response.text();
      let data: HttpCompatibleTtsResponse | null = null;
      try {
        data = rawText ? JSON.parse(rawText) as HttpCompatibleTtsResponse : null;
      } catch {
        data = null;
      }

      if (!response.ok) {
        return fail(`http_${response.status}:${data?.error ?? rawText.slice(0, 160)}`, startedAt, data?.latencyMs);
      }
      if (!data?.ok || !data.audioUrl) {
        return fail(data?.error ?? "http_tts_failed", startedAt, data?.latencyMs);
      }

      const result: TtsGenerateOutput = {
        ok: true,
        provider: this.name,
        audioUrl: absolutizeAudioUrl(data.audioUrl),
        audioPath: data.audioPath,
        format: data.format ?? "wav",
        cached: Boolean(data.cached),
        latencyMs: data.latencyMs ?? Math.round(performance.now() - startedAt)
      };
      void recordRuntimeEvent({
        step: "tts.http.request",
        status: "success",
        durationMs: result.latencyMs,
        context: { cached: result.cached, audioUrl: result.audioUrl }
      });
      return result;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : "http_tts_error", startedAt);
    }
  }
}

function fail(error: string, startedAt: number, latencyMs?: number): TtsGenerateOutput {
  const durationMs = latencyMs ?? Math.round(performance.now() - startedAt);
  void recordRuntimeEvent({ step: "tts.http.request", status: "error", durationMs, error });
  return {
    ok: false,
    provider: "http_compatible",
    cached: false,
    latencyMs: durationMs,
    error
  };
}

function absolutizeAudioUrl(audioUrl: string) {
  if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
  if (!HTTP_TTS_CONFIG.apiUrl) return audioUrl;
  try {
    return new URL(audioUrl, HTTP_TTS_CONFIG.apiUrl).toString();
  } catch {
    return audioUrl;
  }
}
