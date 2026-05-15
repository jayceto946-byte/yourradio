const DEFAULT_TEXT = "这里是 YourRadio。接下来这首不用说得太满，它的声音更像夜里慢慢亮起的一盏灯，节奏不急，留白也够，适合让注意力从上一段旋律里自然落下来。";

const config = {
  baseUrl: normalizeBaseUrl(process.env.QWEN3_TTS_BASE_URL || "http://127.0.0.1:8010"),
  model: process.env.QWEN3_TTS_MODEL || "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  device: process.env.QWEN3_TTS_DEVICE || "cuda",
  dtype: process.env.QWEN3_TTS_DTYPE || "float32",
  speaker: process.env.QWEN3_TTS_SPEAKER || "Vivian",
  language: process.env.QWEN3_TTS_LANGUAGE || "Chinese",
  instruct: process.env.QWEN3_TTS_INSTRUCT || "用温柔，成熟，有亲近感的中文电台女主持声音朗读，语速适中，每段话的最后一句放慢速度，不要夸张，不要播音腔。",
  timeoutMs: Number(process.env.QWEN3_TTS_TIMEOUT_MS || 120000)
};

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const health = await fetchJson(`${config.baseUrl}/health`, { method: "GET" }, 5000).catch((error) => ({ ok: false, error: error.message }));
  if (!health.ok) {
    console.log(JSON.stringify({
      ok: false,
      serviceReachable: false,
      provider: "qwen3_custom_voice",
      baseUrl: config.baseUrl,
      message: "Qwen3 TTS service is not running. Start it from C:\\path\\to\\YourRadio\\tools\\qwen3-tts-server with: uvicorn qwen3_tts_server:app --host 127.0.0.1 --port 8010",
      health
    }, null, 2));
    return;
  }

  const startedAt = Date.now();
  const result = await fetchJson(`${config.baseUrl}/tts/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      text: DEFAULT_TEXT,
      speaker: config.speaker,
      language: config.language,
      instruct: config.instruct
    })
  }, config.timeoutMs);
  const latencyMs = result.latencyMs ?? (Date.now() - startedAt);

  console.log(JSON.stringify({
    ok: Boolean(result.ok),
    serviceReachable: true,
    provider: "qwen3_custom_voice",
    model: result.model ?? config.model,
    device: result.device ?? config.device,
    dtype: result.dtype ?? config.dtype,
    speaker: result.speaker ?? config.speaker,
    language: result.language ?? config.language,
    latencyMs,
    within90s: latencyMs <= 90000,
    within120s: latencyMs <= 120000,
    cached: Boolean(result.cached),
    audioUrl: result.audioUrl,
    audioPath: result.audioPath,
    error: result.error
  }, null, 2));
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, ...data };
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}



