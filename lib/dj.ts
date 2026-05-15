import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { DjContextDebug, DjScript, RadioState, Song, SourceSeed } from "./types";
import { formatTrackForSpeech } from "../src/lib/dj/formatTrackForSpeech";
import { researchSongFacts } from "../src/lib/dj/songResearch";
import type { SongFact, SongResearchResult } from "../src/lib/dj/songFacts";
import { recordLlmCacheStats } from "../src/lib/llm/cacheStats";
import { DJ_JSON_REPAIR_INSTRUCTION, DJ_SYSTEM_PROMPT, DJ_TASK_INSTRUCTION } from "../src/lib/llm/prompts/djSystemPrompt";
import { stableJsonStringify } from "../src/lib/llm/stableJson";
import { buildFallbackDjScript } from "../src/lib/dj/fallbackDjScript";
import { detectBannedDjInternalPhrase, sanitizeRecommendationReason } from "../src/lib/dj/djScriptSanitizer";
import { selectDjScriptMode, type DjScriptMode } from "../src/lib/dj/selectDjScriptMode";
import { buildLlmRequestBody, LLM_CONFIG } from "./llmConfig";

const LLM_TIMEOUT_MS = 8000;
const SONG_RESEARCH_TIMEOUT_MS = 3000;
const CHINESE_SONG_RESEARCH_TIMEOUT_MS = 2200;
const chineseTextPattern = /[\\u3400-\\u9fff]/;

const DJ_SCRIPT_CONFIG = {
  targetCharsExcludingTitle: 85,
  minCharsExcludingTitle: 50,
  maxCharsExcludingTitle: 110
};

const DJ_SCRIPT_BANNED_OVERUSED_OPENERS = [
  "接下来这首",
  "刚才那首之后",
  "现在把节奏",
  "这首和你最近",
  "下一首"
];

type DjScene = "opening" | "normal" | "after_skip" | "after_like";

type GenerateDjLineOptions = {
  sourceSeed?: SourceSeed;
  previousTrack?: { title: string; artist: string; album?: string };
  searchQuery?: string;
  reason?: string;
  scene?: DjScene;
  radioState?: RadioState;
};

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type DeepSeekMessage = { role: "system" | "user"; content: string };

type DjJson = {
  djLine?: string;
  script?: string;
  tone?: string;
  usedContext?: string[];
  usedFactTypes?: string[];
  confidence?: "high" | "medium" | "low" | number;
};

type LastDjScriptDebug = {
  mode: DjScriptMode;
  usedTransition: boolean;
  isChineseTrackLikelyLowCoverage: boolean;
  researchStatus: string;
  factsCount: number;
  bannedPhraseDetected: boolean;
  fallbackUsed: boolean;
  track: { rawTitle: string; speechTitle: string; artist: string; displayArtist: string };
  research: { searched: boolean; wikiSearched: boolean; cached: boolean; triggerReasons: string[]; queries: string[]; wikiQueries: string[]; facts: SongFact[]; latencyMs: number };
  script: { text: string; usedFactTypes: string[]; charCountExcludingTitle: number; source: string };
};

let lastDjScriptDebug: LastDjScriptDebug | null = null;

type TemplateInput = {
  song: Song;
  speechTitle: string;
  displayArtist: string;
  time: string;
  previous: string;
  seed: string;
  reason: string;
  facts: SongFact[];
};

const fallbackTemplates = [
  ({ speechTitle, displayArtist, facts }: TemplateInput) => {
    const album = facts.find((fact) => fact.type === "album");
    return album
      ? `这版资料里，它被放在专辑线索里。稍微留意一下 ${displayArtist} 的《${speechTitle}》，别急着判断，让声音自己把空间打开。`
      : `把灯光再压低一点。${displayArtist} 的《${speechTitle}》来了，让它先铺开，再决定要不要靠近。`;
  },
  ({ speechTitle, displayArtist, previous }: TemplateInput) => previous
    ? `从《${previous}》出来，情绪不用立刻转弯。这里接上 ${displayArtist} 的《${speechTitle}》，像把频道轻轻调到另一格。`
    : `先不做太重的介绍，${displayArtist} 的《${speechTitle}》。今晚的电台，从这一下呼吸开始。`,
  ({ speechTitle, displayArtist, seed }: TemplateInput) => seed
    ? `这次的入口来自你的歌单线索「${seed}」。往外走一步，落到 ${displayArtist} 的《${speechTitle}》，熟悉感还在，但边界更松。`
    : `这里换一个角度听。${displayArtist} 的《${speechTitle}》，不抢戏，只把节奏往前送一点。`,
  ({ speechTitle, displayArtist, time }: TemplateInput) => `${time}适合一点克制的过渡。${displayArtist} 的《${speechTitle}》不需要被大声介绍，放出来就好。`,
  ({ speechTitle, displayArtist, reason }: TemplateInput) => reason
    ? `推荐器挑中它，是因为这条线索和你最近的收听很近。${displayArtist}，《${speechTitle}》，听听它怎么接住前面的余温。`
    : `现在把话收短一点。${displayArtist} 的《${speechTitle}》，让旋律自己把夜里的纹理带出来。`,
  ({ speechTitle, displayArtist, facts }: TemplateInput) => facts.some((fact) => fact.type === "soundtrack")
    ? `这首的资料里带着原声线索，所以别把它只当普通单曲听。${displayArtist} 的《${speechTitle}》，画面感会慢慢浮上来。`
    : `有些歌适合从侧面进入。${displayArtist} 的《${speechTitle}》，不急着亮相，先让低处的情绪往上走。`,
  ({ speechTitle, displayArtist, previous }: TemplateInput) => previous
    ? `刚才的尾音还没完全散开，先别切得太硬。${displayArtist} 的《${speechTitle}》，会把这一段接得更柔软。`
    : `频道稳定下来之后，放一首不需要解释太多的歌。${displayArtist}，《${speechTitle}》。`,
  ({ speechTitle, displayArtist, time }: TemplateInput) => `在这个${time}，我更想放一首能留白的歌。${displayArtist} 的《${speechTitle}》，让注意力慢慢落回声音本身。`,
  ({ speechTitle, displayArtist, seed }: TemplateInput) => seed
    ? `从「${seed}」延伸出来的不是复刻，而是一点相邻的气味。接下来听 ${displayArtist} 的《${speechTitle}》。`
    : `这一首不往热闹里推。${displayArtist} 的《${speechTitle}》，让频道继续保持流动。`,
  ({ speechTitle, displayArtist }: TemplateInput) => `留一小段空白给耳朵。${displayArtist} 的《${speechTitle}》马上进来，像夜里慢慢亮起的一盏灯。`,
  ({ speechTitle, displayArtist, facts }: TemplateInput) => {
    const fact = facts.find((entry) => entry.type === "album" || entry.type === "metadata");
    return fact
      ? `我只取一个可靠线索：${fact.text.replace(/。$/, "")}。现在听 ${displayArtist} 的《${speechTitle}》，把资料放轻，声音放前。`
      : `不用把它说成一个故事。${displayArtist} 的《${speechTitle}》，更适合直接进入，让情绪自己完成转场。`;
  },
  ({ speechTitle, displayArtist, previous }: TemplateInput) => previous
    ? `上一首留下的是一条细线，这里不用剪断。${displayArtist} 的《${speechTitle}》，顺着那条线继续往前。`
    : `现在轮到 ${displayArtist}。这首《${speechTitle}》，适合把频道调得更私人一点。`
];

export async function generateDjLine(song: Song, options: GenerateDjLineOptions = {}): Promise<DjScript> {
  const taste = await loadTaste();
  const debugContext = buildDebugContext(options.radioState, taste.loaded);
  const speech = formatTrackForSpeech({ title: song.title, artist: song.artist, album: song.album });
  const research = await researchWithTimeout(song, options, speech);
  const facts = research.facts.slice(0, 5);
  const mode = selectDjScriptMode({
    factsCount: facts.length,
    hasHighConfidenceFact: facts.some((fact) => fact.confidence >= 0.68),
    recentScriptModes: getRecentScriptModes(options.radioState),
    previousTrackAvailable: Boolean(options.previousTrack),
    isChineseTrackLikelyLowCoverage: Boolean(research.isChineseTrackLikelyLowCoverage)
  });

  if (!LLM_CONFIG.apiKey) {
    return buildFallback(song, options, debugContext, "missing_api_key", speech, facts, mode, research);
  }

  const messages = buildDjMessages(song, options, taste.content, debugContext, speech, research, mode);

  try {
    const first = await requestDeepSeek(messages);
    const firstResult = parseAndValidateDjResponse(first.data, options.radioState, speech, facts, options.sourceSeed, options.previousTrack);
    if (firstResult.line) {
      return buildLlmResult(song, options, debugContext, speech, research, firstResult.line, firstResult.parsed, facts, mode);
    }

    const retry = await requestDeepSeek([...messages, { role: "user", content: DJ_JSON_REPAIR_INSTRUCTION }]);
    const retryResult = parseAndValidateDjResponse(retry.data, options.radioState, speech, facts, options.sourceSeed, options.previousTrack);
    if (retryResult.line) {
      return buildLlmResult(song, options, debugContext, speech, research, retryResult.line, retryResult.parsed, facts, mode);
    }

    return buildFallback(song, options, debugContext, "invalid_llm_output", speech, facts, mode, research);
  } catch (cause) {
    return buildFallback(song, options, debugContext, cause instanceof Error ? cause.message : "llm_error", speech, facts, mode, research);
  }
}
function buildDjMessages(
  song: Song,
  options: GenerateDjLineOptions,
  taste: string,
  debug: DjContextDebug,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  mode: DjScriptMode
): DeepSeekMessage[] {
  return [
    { role: "system", content: DJ_SYSTEM_PROMPT },
    { role: "user", content: DJ_TASK_INSTRUCTION },
    { role: "user", content: stableJsonStringify(buildDjPayload(song, options, taste, debug, speech, research, mode)) }
  ];
}

function buildDjPayload(
  song: Song,
  options: GenerateDjLineOptions,
  taste: string,
  debug: DjContextDebug,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  mode: DjScriptMode
) {
  const previous = mode === "soft_transition" ? options.previousTrack : undefined;
  return {
    facts: research.facts.slice(0, 5).map((fact) => ({
      confidence: fact.confidence,
      sourceName: fact.sourceName,
      text: fact.text,
      type: fact.type
    })),
    nextTrack: {
      album: song.album,
      displayArtist: speech.displayArtist,
      rawTitle: song.title,
      speechTitle: speech.speechTitle
    },
    previousTrack: previous ? { artist: previous.artist, title: previous.title } : undefined,
    recentDjOpenings: options.radioState?.recentDjLines?.slice(0, 3).map((line) => line.slice(0, 18)) ?? [],
    recentTracks: options.radioState?.playHistory.slice(-3).map((entry) => ({ artist: entry.artist, title: entry.title })) ?? [],
    sessionPreviousTrack: options.previousTrack ? { artist: options.previousTrack.artist, title: options.previousTrack.title } : undefined,
    fallbackAllowed: true,
    mode,
    recommendationReason: sanitizeDjRecommendationReason(options.reason),
    research: {
      providers: research.usedProviders,
      triggerReasons: research.triggerReasons ?? [],
      wikiSearched: research.wikiSearched
    },
    scene: options.scene ?? "normal",
    scoreExplanation: sanitizeDjRecommendationReason(options.reason),
    seedContext: buildSeedContext(options.sourceSeed),
    sourceSeed: undefined,
    taste: taste ? taste.slice(0, 900) : "未提供 taste.md",
    timeOfDay: debug.timeOfDay
  };
}
async function requestDeepSeek(messages: DeepSeekMessage[]) {
  const response = await fetchWithTimeout(LLM_CONFIG.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${LLM_CONFIG.apiKey}`
    },
    body: JSON.stringify(buildLlmRequestBody({
      messages,
      model: LLM_CONFIG.model,
      max_tokens: 420,
      response_format: { type: "text" },
      stream: false,
      temperature: 1.05,
      top_p: 0.95
    }, {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stop: null,
      stream_options: null,
      tools: null,
      tool_choice: "none",
      logprobs: false,
      top_logprobs: null
    })),
    cache: "no-store"
  }, LLM_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }

  const data = (await response.json()) as DeepSeekResponse;
  recordLlmCacheStats({ task: "dj_script", usage: data.usage });
  return { data };
}

function parseAndValidateDjResponse(
  data: DeepSeekResponse,
  state: RadioState | undefined,
  speech: ReturnType<typeof formatTrackForSpeech>,
  facts: SongFact[],
  sourceSeed?: SourceSeed,
  previousTrack?: { title: string; artist: string }
) {
  const raw = data.choices?.[0]?.message?.content?.trim();
  const parsed = parseDjJson(raw);
  const line = validateDjLine(cleanDjLine(parsed?.djLine ?? parsed?.script ?? raw), state, speech, sourceSeed, previousTrack);
  return { line, parsed, usedFactTypes: normalizeUsedFactTypes(parsed?.usedFactTypes, facts) };
}

function buildLlmResult(
  song: Song,
  options: GenerateDjLineOptions,
  debugContext: DjContextDebug,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  line: string,
  parsed: DjJson | null,
  facts: SongFact[],
  mode: DjScriptMode
): DjScript {
  const usedFactTypes = normalizeUsedFactTypes(parsed?.usedFactTypes, facts);
  const result: DjScript = {
    mood: parsed?.tone ?? "DeepSeek",
    text: line,
    source: "llm",
    style: mode,
    debug: {
      ...debugContext,
      tone: parsed?.tone,
      usedContext: [
        ...new Set([
          ...(parsed?.usedContext ?? []),
          "speechTitle",
          "displayArtist",
          "facts",
          ...usedFactTypes.map((type) => `fact:${type}`)
        ])
      ],
      confidence: normalizeConfidence(parsed?.confidence),
      source: "llm",
      style: mode
    }
  };
  setLastDjScriptDebug(song, speech, research, result.text, usedFactTypes, "llm", mode, false);
  return result;
}
function buildFallback(
  song: Song,
  options: GenerateDjLineOptions,
  debug: DjContextDebug,
  error: string,
  speech = formatTrackForSpeech({ title: song.title, artist: song.artist, album: song.album }),
  facts: SongFact[] = [],
  mode: DjScriptMode = "mood_note",
  research?: SongResearchResult
): DjScript {
  const text = buildFallbackDjScript({
    speechTitle: speech.speechTitle,
    displayArtist: speech.displayArtist,
    mode,
    timeOfDay: debug.timeOfDay,
    hasFacts: facts.length > 0
  });
  const result: DjScript = {
    mood: "fallback",
    text,
    source: "fallback",
    style: mode,
    error,
    debug: {
      ...debug,
      usedContext: [...debug.usedContext, "speechTitle", "displayArtist", "fallbackTemplate", `mode:${mode}`],
      source: "fallback",
      style: mode,
      error
    }
  };
  setLastDjScriptDebug(song, speech, research ?? {
    trackTitle: song.title,
    artist: song.artist,
    album: song.album,
    facts,
    usedProviders: [],
    searched: false,
    wikiSearched: false,
    cached: false,
    latencyMs: 0,
    queries: [],
    wikiQueries: [],
    triggerReasons: [],
    errors: [],
    researchStatus: "fallback",
    isChineseTrackLikelyLowCoverage: false
  }, result.text, [], "fallback", mode, true);
  return result;
}

function validateDjLine(line: string, state: RadioState | undefined, speech: ReturnType<typeof formatTrackForSpeech>, sourceSeed?: SourceSeed, previousTrack?: { title: string; artist: string }) {
  const text = line.trim();

  if (!text || text.length < 20 || text.length > 230) {
    return "";
  }

  if (/```|^\{|"djLine"|作为AI|以下是|歌词|发行于\d{4}|\d{4}年发行/.test(text)) {
    return "";
  }

  if (speech.removedTitleParts.some((part) => part && text.includes(part))) {
    return "";
  }

  if (detectBannedDjInternalPhrase(text)) {
    return "";
  }

  if (misusesSeedAsPreviousTrack(text, state, sourceSeed, previousTrack)) {
    return "";
  }

  if (state?.recentDjLines?.some((recent) => similarOpening(recent, text) || hasRepeatedOverusedOpener(text, [recent]))) {
    return "";
  }

  return text;
}

function misusesSeedAsPreviousTrack(text: string, state: RadioState | undefined, sourceSeed?: SourceSeed, previousTrack?: { title: string; artist: string }) {
  if (!mentionsPreviousTrack(text)) return false;
  const previous = previousTrack;
  if (!previous) return true;

  const previousTitle = normalizeForMention(previous.title);
  const previousArtist = normalizeForMention(previous.artist);
  const normalizedText = normalizeForMention(text);
  const mentionsRealPrevious = Boolean(previousTitle && normalizedText.includes(previousTitle))
    || Boolean(previousArtist && normalizedText.includes(previousArtist));

  if (mentionsRealPrevious) return false;

  const seedTitle = normalizeForMention(sourceSeed?.title ?? "");
  const seedArtist = normalizeForMention(sourceSeed?.artist ?? "");
  const mentionsSeed = Boolean(seedTitle && normalizedText.includes(seedTitle))
    || Boolean(seedArtist && normalizedText.includes(seedArtist));

  return mentionsSeed || true;
}

function mentionsPreviousTrack(text: string) {
  return /上一首|上一曲|上首|刚才那首|剛才那首|刚刚那首|前一首|前一曲|上一段|刚才的|剛才的/.test(text);
}

function normalizeForMention(value: string) {
  return value.toLowerCase().replace(/[《》「」“”'"\s\-_:：，,。.!！?？()（）\[\]]+/g, "").trim();
}

function buildSeedContext(seed?: SourceSeed) {
  if (!seed) return undefined;
  const label = [seed.title, seed.artist].filter(Boolean).join(" - ") || seed.album || "";
  if (!label) return undefined;
  return {
    label,
    rule: "推荐来源，不是真实上一首；不要称它为上一首、刚才那首或前一首。"
  };
}

function sanitizeDjRecommendationReason(value?: string) {
  const sanitized = sanitizeRecommendationReason(value);
  if (!sanitized) return "";
  return sanitized
    .replace(/SeedMode\s+base_random\.?/ig, "")
    .replace(/Used seeds?:.*?(?=Ranker score|$)/ig, "")
    .replace(/Ranker score.*$/ig, "")
    .replace(/seedMode=.*?(;|$)/ig, "")
    .replace(/seed[:：][^。；;，,]+/ig, "")
    .replace(/\s+/g, " ")
    .replace(/[，,。；;：:]{2,}/g, "，")
    .trim()
    .slice(0, 90);
}
function cleanDjLine(line?: string) {
  return (line ?? "")
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^主播[:：]/, "")
    .trim();
}

function parseDjJson(raw?: string): DjJson | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const jsonText = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(jsonText) as DjJson;
  } catch {
    return null;
  }
}

function similarOpening(a: string, b: string) {
  return getOpening(a) === getOpening(b);
}

function hasRepeatedOverusedOpener(text: string, recent: string[]) {
  const opener = DJ_SCRIPT_BANNED_OVERUSED_OPENERS.find((item) => text.startsWith(item));
  return Boolean(opener && recent.some((line) => line.startsWith(opener)));
}

function getOpening(value: string) {
  return value.replace(/^[《「“\s]+/, "").slice(0, 12);
}

function pickStyle(scene?: DjScene, salt = Math.floor(Math.random() * 8)) {
  if (scene === "after_skip") return "skip-reset";
  if (scene === "after_like") return "like-extension";
  const styles = ["opening", "transition", "mood", "time", "seed", "fact", "light", "night"];
  return styles[salt % styles.length];
}

function buildDebugContext(state: RadioState | undefined, tasteLoaded: boolean): DjContextDebug {
  const hour = new Date().getHours();
  const timeOfDay = hour < 6 ? "深夜" : hour < 11 ? "上午" : hour < 14 ? "午间" : hour < 18 ? "下午" : hour < 22 ? "夜晚" : "深夜";
  return {
    usedContext: ["artist", "album", "sourceSeed", "reason", "recentTracks", "recentDjLines", "timeOfDay", "taste"],
    confidence: "medium",
    timeOfDay,
    recentTracks: state?.playHistory.slice(-5).map((entry) => `${entry.title} - ${entry.artist}`) ?? [],
    tasteLoaded
  };
}

async function researchWithTimeout(song: Song, options: GenerateDjLineOptions, speech: ReturnType<typeof formatTrackForSpeech>) {
  const timeoutMs = chineseTextPattern.test(`${song.title} ${song.artist}`) ? CHINESE_SONG_RESEARCH_TIMEOUT_MS : SONG_RESEARCH_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      researchSongFacts({
        rawTitle: song.title,
        speechTitle: speech.speechTitle,
        rawArtist: song.artist,
        displayArtist: speech.displayArtist,
        album: song.album,
        recommendationReason: options.reason,
        prepareTimeBudgetMs: timeoutMs,
        isSoundtrackLike: speech.isSoundtrackLike,
        featuredArtists: speech.featuredArtists
      }),
      new Promise<SongResearchResult>((resolve) => {
        timeout = setTimeout(() => resolve({
          trackTitle: song.title,
          artist: song.artist,
          album: song.album,
          facts: [],
          usedProviders: [],
          searched: false,
          wikiSearched: false,
                cached: false,
          latencyMs: timeoutMs,
          queries: [],
          wikiQueries: [],
                errors: ["song_research_timeout"],
          researchStatus: "timeout",
          isChineseTrackLikelyLowCoverage: chineseTextPattern.test(`${song.title} ${song.artist}`)
        }), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadTaste() {
  try {
    const content = await readFile(path.join(process.cwd(), "user", "taste.md"), "utf8");
    return { loaded: true, content: content.slice(0, 1600) };
  } catch {
    return { loaded: false, content: "" };
  }
}

function normalizeConfidence(value: DjJson["confidence"]): "high" | "medium" | "low" {
  if (value === "high" || value === "medium" || value === "low") return value;
  if (typeof value === "number") return value >= 0.75 ? "high" : value >= 0.45 ? "medium" : "low";
  return "medium";
}

function normalizeUsedFactTypes(values: string[] | undefined, facts: SongFact[]) {
  const available = new Set(facts.map((fact) => fact.type));
  return (values ?? []).filter((value) => available.has(value as SongFact["type"]));
}

function getEnvValue(name: string): string | undefined;
function getEnvValue(name: string, fallback: string): string;
function getEnvValue(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export const generateMockDjScript = generateDjLine;





function setLastDjScriptDebug(
  song: Song,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  text: string,
  usedFactTypes: string[],
  source: string,
  mode: DjScriptMode,
  fallbackUsed: boolean
) {
  const bannedPhrase = detectBannedDjInternalPhrase(text);
  lastDjScriptDebug = {
    mode,
    usedTransition: mode === "soft_transition",
    isChineseTrackLikelyLowCoverage: Boolean(research.isChineseTrackLikelyLowCoverage),
    researchStatus: research.researchStatus ?? (research.errors.length ? "fallback" : "success"),
    factsCount: research.facts.length,
    bannedPhraseDetected: Boolean(bannedPhrase),
    fallbackUsed,
    track: { rawTitle: song.title, speechTitle: speech.speechTitle, artist: song.artist, displayArtist: speech.displayArtist },
    research: {
      searched: research.searched,
      wikiSearched: research.wikiSearched,
      cached: research.cached,
      triggerReasons: research.triggerReasons ?? [],
      queries: research.queries ?? [],
      wikiQueries: research.wikiQueries ?? [],
      facts: research.facts,
      latencyMs: research.latencyMs
    },
    script: {
      text,
      usedFactTypes,
      charCountExcludingTitle: Math.max(0, text.length - speech.speechTitle.length - speech.displayArtist.length),
      source
    }
  };
}

function getRecentScriptModes(state?: RadioState): DjScriptMode[] {
  const inferred = state?.recentDjLines?.slice(0, 5).map((line) => {
    if (/刚才|上一首|转场|接上/.test(line)) return "soft_transition" as const;
    if (line.length < 34) return "direct_play" as const;
    return "mood_note" as const;
  }) ?? [];
  return lastDjScriptDebug ? [lastDjScriptDebug.mode, ...inferred] : inferred;
}

export function getLastDjScriptDebug() {
  return lastDjScriptDebug;
}




























