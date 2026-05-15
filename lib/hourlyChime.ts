
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { prepareDjTts } from "./tts";
import { measureRuntimeStep, recordRuntimeEvent } from "./runtimeLog";
import { recordLlmCacheStats } from "../src/lib/llm/cacheStats";
import { stableJsonStringify } from "../src/lib/llm/stableJson";
import type { PreparedTtsResult } from "./tts";
import { buildLlmRequestBody, LLM_CONFIG } from "./llmConfig";

const HOURLY_CHIME_DIR = path.join(process.cwd(), "data", "hourly-chime");
const HOURLY_CHIME_TTS_TIMEOUT_MS = Number(process.env.HOURLY_CHIME_TTS_TIMEOUT_MS ?? 120000);
const HOURLY_CHIME_TTS_BUDGET_MS = Number(process.env.HOURLY_CHIME_TTS_BUDGET_MS ?? 120000);
const HOURLY_CHIME_WEATHER_LOCATION = process.env.HOURLY_CHIME_WEATHER_LOCATION?.trim() || "Shanghai";
const HOURLY_CHIME_DISPLAY_LOCATION = process.env.HOURLY_CHIME_DISPLAY_LOCATION?.trim() || "\u4e0a\u6d77";
const HOURLY_CHIME_LATITUDE = Number(process.env.HOURLY_CHIME_LATITUDE ?? 31.2304);
const HOURLY_CHIME_LONGITUDE = Number(process.env.HOURLY_CHIME_LONGITUDE ?? 121.4737);
const TIME_ZONE = process.env.HOURLY_CHIME_TIME_ZONE?.trim() || "Asia/Shanghai";
const LLM_TIMEOUT_MS = Number(process.env.HOURLY_CHIME_LLM_TIMEOUT_MS ?? 8000);
const WEATHER_TIMEOUT_MS = Number(process.env.HOURLY_CHIME_WEATHER_TIMEOUT_MS ?? 5000);

const HOURLY_CHIME_SYSTEM_PROMPT = `You are the hourly time-check host for YourRadio. Output only JSON: {"script":"..."}.
Rules:
- Write natural, everyday Chinese, like a private late-night radio host, not news broadcast copy.
- The script must include the current time.
- The script must include weather information.
- Mention what people may be doing around this time: waking up, work/study, lunch/rest, afternoon focus dip, evening wrap-up, late-night work or going to sleep.
- Do not mention API, model, weather source, algorithm, cache, or system.
- Keep it around 45 to 90 Chinese characters.
- Output no explanation outside JSON.`;

const HOURLY_CHIME_TASK_INSTRUCTION = "Generate one natural Chinese hourly time-check script from the final JSON payload.";
const HOURLY_CHIME_JSON_REPAIR = "The previous output was not valid JSON. Return strictly valid JSON matching the schema.";

type DeepSeekResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type HourlyChimeMessage = { role: "system" | "user"; content: string };

type WeatherSummary = {
  ok: boolean;
  location: string;
  text: string;
  temperatureC?: number;
  condition?: string;
  humidity?: number;
  windKmph?: number;
  error?: string;
};

export type HourlyChimePackage = {
  ok: true;
  targetHourIso: string;
  targetHourKey: string;
  timeText: string;
  timeOfDay: string;
  weather: WeatherSummary;
  script: string;
  tts: PreparedTtsResult;
  audioUrl?: string;
  audioPath?: string;
  cached: boolean;
  generatedAt: string;
};

export async function prepareHourlyChime(input: { targetHourIso?: string; force?: boolean } = {}): Promise<HourlyChimePackage> {
  const target = normalizeTargetHour(input.targetHourIso ? new Date(input.targetHourIso) : getNextTopOfHour(new Date()));
  const targetHourIso = target.toISOString();
  const targetHourKey = buildTargetHourKey(target);
  const cached = input.force ? null : await readCachedHourlyChime(targetHourKey);
  if (cached) {
    void recordRuntimeEvent({ step: "hourlyChime.prepare", status: "info", message: "cache_hit", context: { targetHourKey, audioUrl: cached.audioUrl } });
    return { ...cached, cached: true };
  }

  return measureRuntimeStep("hourlyChime.prepare", { targetHourKey, location: HOURLY_CHIME_DISPLAY_LOCATION, force: Boolean(input.force) }, async () => {
    const weather = await fetchWeatherSummary();
    const timeText = formatTargetTime(target);
    const timeOfDay = describeTimeOfDay(target);
    const script = await generateHourlyChimeScript({ target, timeText, timeOfDay, weather }).catch((cause) => {
      void recordRuntimeEvent({ step: "hourlyChime.llm", status: "error", error: cause instanceof Error ? cause.message : String(cause), context: { targetHourKey } });
      return buildFallbackHourlyChimeScript({ timeText, timeOfDay, weather });
    });
    const tts = await prepareDjTts({ text: script, mood: "hourly_chime", source: "llm" }, {
      timeoutMs: HOURLY_CHIME_TTS_TIMEOUT_MS,
      budgetMs: HOURLY_CHIME_TTS_BUDGET_MS,
      priority: "low"
    });
    const pkg: HourlyChimePackage = {
      ok: true,
      targetHourIso,
      targetHourKey,
      timeText,
      timeOfDay,
      weather,
      script,
      tts,
      audioUrl: tts.audioUrl,
      audioPath: tts.audioPath,
      cached: false,
      generatedAt: new Date().toISOString()
    };
    await writeCachedHourlyChime(pkg);
    return pkg;
  });
}

export async function getHourlyChimeStatus(targetHourIso?: string) {
  const target = normalizeTargetHour(targetHourIso ? new Date(targetHourIso) : getNextTopOfHour(new Date()));
  const targetHourKey = buildTargetHourKey(target);
  const cached = await readCachedHourlyChime(targetHourKey);
  return { ok: true, targetHourIso: target.toISOString(), targetHourKey, cached: Boolean(cached), package: cached };
}

async function generateHourlyChimeScript(input: { target: Date; timeText: string; timeOfDay: string; weather: WeatherSummary }) {
  if (!LLM_CONFIG.apiKey) return buildFallbackHourlyChimeScript(input);
  const payload = {
    location: HOURLY_CHIME_DISPLAY_LOCATION,
    targetTime: input.timeText,
    timeOfDay: input.timeOfDay,
    weather: input.weather.text,
    lifestyleHint: getLifestyleHint(input.target),
    output: { language: "zh-CN", maxChineseChars: 90 }
  };
  const messages: HourlyChimeMessage[] = [
    { role: "system", content: HOURLY_CHIME_SYSTEM_PROMPT },
    { role: "user", content: HOURLY_CHIME_TASK_INSTRUCTION },
    { role: "user", content: stableJsonStringify(payload) }
  ];
  const first = await requestDeepSeek(messages);
  const parsed = parseHourlyChimeJson(first);
  if (parsed) return parsed;
  const retry = await requestDeepSeek([...messages, { role: "user", content: HOURLY_CHIME_JSON_REPAIR }]);
  return parseHourlyChimeJson(retry) || buildFallbackHourlyChimeScript(input);
}

async function requestDeepSeek(messages: HourlyChimeMessage[]) {
  const response = await fetchWithTimeout(LLM_CONFIG.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${LLM_CONFIG.apiKey}` },
    body: JSON.stringify(buildLlmRequestBody({
      messages,
      model: LLM_CONFIG.model,
      max_tokens: 260,
      response_format: { type: "text" },
      stream: false,
      temperature: 0.95,
      top_p: 0.9
    }, {
      thinking: { type: "disabled" },
      tools: null,
      tool_choice: "none"
    })),
    cache: "no-store"
  }, LLM_TIMEOUT_MS);
  if (!response.ok) throw new Error(`http_${response.status}`);
  const data = await response.json() as DeepSeekResponse;
  recordLlmCacheStats({ task: "hourly_chime", usage: data.usage });
  return data;
}

function parseHourlyChimeJson(data: DeepSeekResponse) {
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) return "";
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const text = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    const parsed = JSON.parse(text) as { script?: string };
    return sanitizeScript(parsed.script);
  } catch {
    return sanitizeScript(cleaned);
  }
}

function sanitizeScript(value?: string) {
  const script = (value ?? "")
    .replace(/^\u811a\u672c[:\uff1a]/, "")
    .replace(/(API|\u63a5\u53e3|\u6a21\u578b|\u7b97\u6cd5|\u7f13\u5b58|\u7cfb\u7edf|DeepSeek|Qwen|Wiki)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!script) return "";
  return script.length > 120 ? `${script.slice(0, 118)}\u2026` : script;
}


async function fetchWeatherSummary(): Promise<WeatherSummary> {
  const openMeteo = await fetchOpenMeteoWeather();
  if (openMeteo.ok) return openMeteo;
  const wttr = await fetchWttrWeather();
  if (wttr.ok) return wttr;
  return {
    ok: false,
    location: HOURLY_CHIME_DISPLAY_LOCATION,
    text: `${HOURLY_CHIME_DISPLAY_LOCATION}\u5929\u6c14\u4fe1\u606f\u6682\u65f6\u6ca1\u62ff\u7a33\uff0c\u51fa\u95e8\u524d\u518d\u770b\u4e00\u773c\u3002`,
    error: openMeteo.error || wttr.error || "weather_error"
  };
}

async function fetchOpenMeteoWeather(): Promise<WeatherSummary> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(HOURLY_CHIME_LATITUDE));
    url.searchParams.set("longitude", String(HOURLY_CHIME_LONGITUDE));
    url.searchParams.set("current", "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m");
    url.searchParams.set("timezone", TIME_ZONE);
    const response = await fetchWithTimeout(url, { headers: { Accept: "application/json", "User-Agent": "YourRadio/0.1.0" }, cache: "no-store" }, WEATHER_TIMEOUT_MS);
    if (!response.ok) throw new Error(`open_meteo_http_${response.status}`);
    const data = await response.json() as { current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number; wind_speed_10m?: number } };
    const current = data.current;
    if (!current) throw new Error("open_meteo_empty");
    const temperatureC = Number(current.temperature_2m);
    const humidity = Number(current.relative_humidity_2m);
    const windKmph = Number(current.wind_speed_10m);
    const condition = describeWeatherCode(Number(current.weather_code));
    return { ok: true, location: HOURLY_CHIME_DISPLAY_LOCATION, text: buildWeatherText({ condition, temperatureC, humidity, windKmph }), temperatureC, condition, humidity, windKmph };
  } catch (cause) {
    return { ok: false, location: HOURLY_CHIME_DISPLAY_LOCATION, text: "", error: cause instanceof Error ? cause.message : "open_meteo_error" };
  }
}

async function fetchWttrWeather(): Promise<WeatherSummary> {
  const location = HOURLY_CHIME_WEATHER_LOCATION;
  try {
    const response = await fetchWithTimeout(`https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`, { headers: { Accept: "application/json", "User-Agent": "YourRadio/0.1.0" }, cache: "no-store" }, WEATHER_TIMEOUT_MS);
    if (!response.ok) throw new Error(`wttr_http_${response.status}`);
    const data = await response.json() as { current_condition?: Array<{ temp_C?: string; humidity?: string; windspeedKmph?: string; weatherDesc?: Array<{ value?: string }> }> };
    const current = data.current_condition?.[0];
    if (!current) throw new Error("wttr_empty");
    const temperatureC = Number(current.temp_C);
    const humidity = Number(current.humidity);
    const windKmph = Number(current.windspeedKmph);
    const condition = current.weatherDesc?.[0]?.value?.trim() || "\u5929\u6c14\u5e73\u7a33";
    return { ok: true, location: HOURLY_CHIME_DISPLAY_LOCATION, text: buildWeatherText({ condition, temperatureC, humidity, windKmph }), temperatureC, condition, humidity, windKmph };
  } catch (cause) {
    return { ok: false, location: HOURLY_CHIME_DISPLAY_LOCATION, text: "", error: cause instanceof Error ? cause.message : "wttr_error" };
  }
}

function buildWeatherText(input: { condition: string; temperatureC?: number; humidity?: number; windKmph?: number }) {
  const parts = [
    `${HOURLY_CHIME_DISPLAY_LOCATION}${input.condition}`,
    Number.isFinite(input.temperatureC) ? `${Math.round(input.temperatureC as number)}\u5ea6` : "",
    Number.isFinite(input.humidity) ? `\u6e7f\u5ea6${Math.round(input.humidity as number)}%` : "",
    Number.isFinite(input.windKmph) ? `\u98ce\u901f${Math.round(input.windKmph as number)}\u516c\u91cc\u6bcf\u5c0f\u65f6` : ""
  ].filter(Boolean);
  return parts.join("\uff0c");
}

function describeWeatherCode(code: number) {
  if (code === 0) return "\u6674";
  if ([1, 2].includes(code)) return "\u5c11\u4e91";
  if (code === 3) return "\u591a\u4e91";
  if ([45, 48].includes(code)) return "\u6709\u96fe";
  if ([51, 53, 55, 56, 57].includes(code)) return "\u6709\u5c0f\u96e8";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "\u6709\u96e8";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "\u6709\u96ea";
  if ([95, 96, 99].includes(code)) return "\u53ef\u80fd\u6709\u96f7\u9635\u96e8";
  return "\u5929\u6c14\u5e73\u7a33";
}

function buildFallbackHourlyChimeScript(input: { timeText: string; timeOfDay: string; weather: WeatherSummary }) {
  const hint = getFallbackHint(input.timeOfDay);
  return `${input.timeText}\u6574\uff0c${input.weather.text}\u3002${hint}`.replace(/\s+/g, " ").trim();
}

function getFallbackHint(timeOfDay: string) {
  if (timeOfDay === "\u6e05\u6668") return "\u5982\u679c\u521a\u9192\uff0c\u5148\u8ba9\u8eab\u4f53\u6162\u6162\u8fdb\u5165\u4eca\u5929\u3002";
  if (timeOfDay === "\u4e0a\u5348") return "\u9002\u5408\u628a\u624b\u5934\u7684\u4e8b\u7a33\u7a33\u63a8\u8fdb\u4e00\u70b9\u3002";
  if (timeOfDay === "\u4e2d\u5348") return "\u8bb0\u5f97\u5403\u996d\uff0c\u4e5f\u7ed9\u81ea\u5df1\u7559\u4e00\u5c0f\u6bb5\u4f11\u606f\u3002";
  if (timeOfDay === "\u4e0b\u5348") return "\u6ce8\u610f\u529b\u6709\u70b9\u6563\u4e5f\u6b63\u5e38\uff0c\u559d\u53e3\u6c34\u7f13\u4e00\u4e0b\u3002";
  if (timeOfDay === "\u591c\u665a") return "\u5982\u679c\u8fd8\u5728\u5fd9\uff0c\u4e5f\u522b\u628a\u81ea\u5df1\u7ef7\u5f97\u592a\u7d27\u3002";
  return "\u591c\u6df1\u4e86\uff0c\u80fd\u6536\u5c3e\u5c31\u6162\u6162\u6536\u5c3e\uff0c\u522b\u592a\u786c\u6491\u3002";
}

function getLifestyleHint(target: Date) {
  return getFallbackHint(describeTimeOfDay(target));
}

function normalizeTargetHour(value: Date) {
  const date = Number.isFinite(value.getTime()) ? new Date(value) : getNextTopOfHour(new Date());
  date.setMinutes(0, 0, 0);
  return date;
}

function getNextTopOfHour(now: Date) {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  if (next <= now) next.setHours(next.getHours() + 1);
  return next;
}

function buildTargetHourKey(value: Date) {
  return value.toISOString().slice(0, 13).replace(/[-:T]/g, "");
}

function getCachePath(targetHourKey: string) {
  return path.join(HOURLY_CHIME_DIR, `${targetHourKey}.json`);
}

async function readCachedHourlyChime(targetHourKey: string): Promise<HourlyChimePackage | null> {
  try {
    const raw = await readFile(getCachePath(targetHourKey), "utf8");
    const pkg = JSON.parse(raw) as HourlyChimePackage;
    if (!pkg.audioUrl && !pkg.script) return null;
    return pkg;
  } catch {
    return null;
  }
}

async function writeCachedHourlyChime(pkg: HourlyChimePackage) {
  await mkdir(HOURLY_CHIME_DIR, { recursive: true });
  await writeFile(getCachePath(pkg.targetHourKey), JSON.stringify(pkg, null, 2), "utf8");
}

function formatTargetTime(target: Date) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: false }).formatToParts(target);
  const hour = parts.find((part) => part.type === "hour")?.value ?? String(target.getHours());
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function describeTimeOfDay(target: Date) {
  const hourText = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hour12: false }).format(target);
  const hour = Number(hourText);
  if (hour >= 5 && hour < 8) return "\u6e05\u6668";
  if (hour >= 8 && hour < 12) return "\u4e0a\u5348";
  if (hour >= 12 && hour < 14) return "\u4e2d\u5348";
  if (hour >= 14 && hour < 18) return "\u4e0b\u5348";
  if (hour >= 18 && hour < 23) return "\u591c\u665a";
  return "\u6df1\u591c";
}
